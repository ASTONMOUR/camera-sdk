"""FastAPI application factory for the Product Capture service.

Every HTTP concern lives here; the detection, quality, enhance, OCR, and
compliance modules are imported and called as plain functions. The session
store is an in-memory dict — it resets on restart, which is fine for a dev
server and a controlled kiosk deployment. If you need persistence, swap
``_SESSIONS`` for a shelve or sqlite store with the same dict interface.

Routes
------
GET  /api/health                 — service status
POST /api/session                — start a capture session, returns plan
POST /api/capture                — submit one surface image, returns quality
GET  /api/session/{id}           — poll session state
POST /api/compliance             — run OCR + adjudication over all surfaces
GET  /api/compliance/{id}        — retrieve a stored compliance result
GET  /                           — redirect to the shape picker
GET  /index.html                 — shape selection screen
GET  /capture.html               — the zero-build capture UI
"""

from __future__ import annotations

import base64
import logging
import os
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from labelcheck.engine import load_rules
from productcapture import analytics
from productcapture.capture import build_plan, surface_for_slot
from productcapture.compliance import run as compliance_run
from productcapture.enhance import enhance
from productcapture.ocr import active_backend
from productcapture.quality import assess_quality
from productcapture.schemas import (
    CaptureRequest,
    CaptureResponse,
    ComplianceRequest,
    ComplianceResponse,
    HealthResponse,
    SessionRequest,
    SessionResponse,
)
from productcapture.vision import detect_packet

LOGGER = logging.getLogger(__name__)

# Where per-session image files live. Each session gets its own subdirectory.
# Defaults to a project-local .sessions/ (make sure the repo root is writable);
# override with PRODUCTCAPTURE_SESSION_DIR. Not /tmp: macOS sandboxes it.
_DEFAULT_ROOT = Path(__file__).parent.parent.parent / ".sessions"


def session_root() -> Path:
    """Resolve the session directory on every call.

    Read at call time rather than import time on purpose: bound at import, the
    environment variable is unsettable by anything that imports this module
    first — which is every test, and every embedder that configures its process
    after loading it.
    """
    return Path(os.environ.get("PRODUCTCAPTURE_SESSION_DIR", str(_DEFAULT_ROOT)))

_SESSIONS: dict[str, dict[str, Any]] = {}
_COMPLIANCE_CACHE: dict[str, dict[str, Any]] = {}
_LOCK = Lock()
# ponytail: global lock; per-session locks if throughput matters

VERSION = "1.0.0"
SERVICE_NAME = "productcapture"


def _session_dir(session_id: str) -> Path:
    d = session_root() / session_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _decode_image(b64: str) -> np.ndarray:
    """Decode a base64-encoded JPEG/PNG into a BGR numpy array."""
    raw = base64.b64decode(b64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image — check that it is a valid JPEG or PNG")
    return img


def create_app() -> FastAPI:
    app = FastAPI(
        title="Product Capture API",
        description="Guided capture, quality assessment, OCR, and Legal Metrology compliance.",
        version=VERSION,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Serve the zero-build web SDK from web/ if it exists beside the package root.
    _web_dir = Path(__file__).parent.parent.parent / "web"
    if _web_dir.is_dir():
        app.mount("/static", StaticFiles(directory=str(_web_dir)), name="static")

    # ------------------------------------------------------------------ health

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> dict:
        with _LOCK:
            sessions = len(_SESSIONS)
        table = load_rules()
        return {
            "status": "ok",
            "service": SERVICE_NAME,
            "version": VERSION,
            "ocr_backend": active_backend(),
            "compliance_rules": len(table.rules),
            "sessions": sessions,
        }

    # ------------------------------------------------------------------ session

    @app.post("/api/session", response_model=SessionResponse)
    def create_session(req: SessionRequest) -> dict:
        with analytics.Timer("session_create"):
            session_id = req.session_id or str(uuid.uuid4())
            plan = build_plan(req.shape)
            with _LOCK:
                _SESSIONS[session_id] = {
                    "shape": req.shape,
                    "steps": plan["steps"],
                    "surfaces": {},   # surface_name → path
                    "created_at": time.time(),
                }
        return {
            "session_id": session_id,
            "shape": req.shape,
            "steps": plan["steps"],
            "total_steps": plan["total_steps"],
            "model_present": bool(os.environ.get("PRODUCTCAPTURE_YOLO_PATH")),
            "ocr_backend": active_backend(),
        }

    @app.get("/api/session/{session_id}")
    def get_session(session_id: str) -> JSONResponse:
        with _LOCK:
            session = _SESSIONS.get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        return JSONResponse({
            "session_id": session_id,
            "shape": session["shape"],
            "steps": session["steps"],
            "surfaces_captured": list(session["surfaces"].keys()),
            "complete": set(session["steps"]) <= set(session["surfaces"].keys()),
        })

    # ------------------------------------------------------------------ capture

    @app.post("/api/capture", response_model=CaptureResponse)
    def capture(req: CaptureRequest) -> dict:
        with _LOCK:
            session = _SESSIONS.get(req.session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")

        with analytics.Timer("capture"):
            try:
                image = _decode_image(req.image_b64)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

            detection = detect_packet(image)
            quality = assess_quality(
                image,
                box=detection.get("box") or None,
                quad=detection.get("quad"),
            )
            enhanced = enhance(image, box=detection.get("box"), quad=detection.get("quad"))

            sdir = _session_dir(req.session_id)
            jpg_path = sdir / f"{req.slot}.jpg"
            cv2.imwrite(str(jpg_path), enhanced, [cv2.IMWRITE_JPEG_QUALITY, 92])

        with _LOCK:
            session["surfaces"][req.slot] = str(jpg_path)

        analytics.record("surface_captured")
        return {
            "session_id": req.session_id,
            "slot": req.slot,
            "surface": surface_for_slot(req.slot),
            "stored": True,
            "path": str(jpg_path),
            "image_quality": {
                k: v for k, v in quality.items()
                if isinstance(v, (int, float, bool))
            },
        }

    # ------------------------------------------------------------------ compliance

    @app.post("/api/compliance", response_model=ComplianceResponse)
    def compliance(req: ComplianceRequest) -> dict:
        with _LOCK:
            session = _SESSIONS.get(req.session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")

        with analytics.Timer("compliance"):
            sdir = _session_dir(req.session_id)
            surfaces = list(session["surfaces"].keys())
            result = compliance_run(
                session_dir=sdir,
                surfaces=surfaces,
                pack_shape=session["shape"],
            )

        result["session_id"] = req.session_id
        result["shape"] = session["shape"]

        with _LOCK:
            _COMPLIANCE_CACHE[req.session_id] = result

        analytics.record("compliance_run")
        return result

    @app.get("/api/compliance/{session_id}", response_model=ComplianceResponse)
    def get_compliance(session_id: str) -> dict:
        with _LOCK:
            result = _COMPLIANCE_CACHE.get(session_id)
        if result is None:
            raise HTTPException(
                status_code=404,
                detail="No compliance result for this session yet — POST /api/compliance first",
            )
        return result

    # ------------------------------------------------------------------ static UI

    @app.get("/")
    def root() -> RedirectResponse:
        return RedirectResponse(url="/index.html")

    def _page(name: str) -> FileResponse:
        candidate = _web_dir / name
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail=f"{name} not found in web/")
        return FileResponse(str(candidate), media_type="text/html")

    @app.get("/index.html")
    def index_html() -> FileResponse:
        return _page("index.html")

    @app.get("/capture.html")
    def capture_html() -> FileResponse:
        return _page("capture.html")

    return app


# Allow `python -m productcapture.app` for quick manual testing.
app = create_app()
