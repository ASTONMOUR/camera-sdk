"""The wire shapes of the capture service.

These are the contracts the HTTP layer speaks, and they intentionally mirror the
LabelCheck data contract (``labelcheck.contract``) so that nothing is translated twice.
A surface result carries exactly the keys ``labelcheck.extract`` produces, so a capture
can be fed straight into ``merge_surfaces`` without reshaping.

Everything here is Pydantic so that a malformed request is rejected before it reaches
the vision or OCR code — and so the OpenAPI document the service exposes is real.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

PackShape = Literal["flat", "cylindrical"]
Surface = Literal["front", "back", "side", "base", "unknown"]

# A capture *slot* is one step of the guided flow; a *surface* is LabelCheck's
# vocabulary. They are not the same thing: a cylinder is photographed from two
# different sides, and both are "side" to the rule engine. Keying storage on the
# surface would make the second side overwrite the first.
Slot = Literal["front", "back", "side_1", "side_2", "top", "base"]

# The slot order a shape requires. Flat packs carry declarations on two faces;
# cylindrical packs are photographed in 90° turns so the seam and any "see base"
# instruction are not missed, then the lid and the base.
SURFACE_SEQUENCES: dict[str, tuple[Slot, ...]] = {
    "flat": ("front", "back"),
    "cylindrical": ("front", "side_1", "back", "side_2", "top", "base"),
}

# LabelCheck has no "top" surface. A lid carries the same class of declarations
# as a base ("see lid for expiry" and "see base of can" are the same instruction
# from the rule engine's point of view), so it adjudicates as one.
SLOT_SURFACE: dict[str, Surface] = {
    "front": "front",
    "back": "back",
    "side_1": "side",
    "side_2": "side",
    "top": "base",
    "base": "base",
}


class ShapeOption(BaseModel):
    """One selectable package shape, with the examples the UI shows."""

    id: PackShape
    label: str
    examples: list[str]
    surfaces: list[Slot]


class HealthResponse(BaseModel):
    """What the service reports about itself."""

    status: Literal["ok"]
    service: str
    version: str
    ocr_backend: Literal["paddleocr", "gemini", "offline"]
    compliance_rules: int
    sessions: int


class SessionRequest(BaseModel):
    """Ask to begin a guided capture for one package."""

    shape: PackShape
    session_id: str | None = Field(
        default=None,
        description="Optional client-chosen id, so a resumable app can keep its own key.",
    )


class SessionResponse(BaseModel):
    """The capture plan; what the overlay should ask the user to do, in order."""

    session_id: str
    shape: PackShape
    steps: list[Slot]
    total_steps: int
    model_present: bool
    ocr_backend: Literal["paddleocr", "gemini", "offline"]


class QualityReport(BaseModel):
    """Quality scores for one frame, each in 0.0..1.0 unless stated otherwise.

    ``ready`` is the boolean the auto-capture state machine keys on; every individual
    score is included so the UI can name the one thing wrong.
    """

    blur: float
    brightness: float
    exposure_good: bool
    glare: float
    reflection: bool
    motion: float
    sharpness: float
    packet_present: bool
    packet_centered: bool
    packet_size_ok: bool
    perspective_ok: bool
    multiple_packets: bool
    duplicate: bool
    ready: bool
    reasons: list[str]


class FrameAnalysis(BaseModel):
    """Everything the per-frame detector reports of the packet in view."""

    box: list[float] = Field(default_factory=list, description="[x, y, w, h] in pixels")
    center: list[float] = Field(default_factory=list, description="[cx, cy] in pixels")
    confidence: float = 0.0
    angle: float = 0.0
    area: float = 0.0
    aspect_ratio: float = 0.0
    distance_cm: float | None = None
    quality: QualityReport


class CaptureRequest(BaseModel):
    """Submit one enhanced capture of a given slot."""

    session_id: str
    slot: Slot
    image_b64: str
    quality: QualityReport | None = None


class CaptureResponse(BaseModel):
    """Confirmation that one slot image was stored for this session."""

    session_id: str
    slot: Slot
    surface: Surface
    stored: bool
    path: str
    image_quality: dict[str, float | bool]


class ComplianceRequest(BaseModel):
    """Ask for the compliance report over all captured surfaces of a session."""

    session_id: str
    transcribe: bool = Field(
        default=True,
        description="False to adjudicate only surfaces already cached as .json transcripts.",
    )


class MetadataField(BaseModel):
    """One extracted declaration field, mirroring labelcheck's {value, confidence}."""

    value: str | None = None
    confidence: float = 0.0
    as_printed: str | None = None


class ComplianceResponse(BaseModel):
    """The structured report: extracted fields, quality, and the six-state verdicts."""

    session_id: str
    shape: PackShape | None = None
    surfaces_captured: list[Surface]
    worst: str
    summary: dict[str, int]
    fields: dict[str, MetadataField]
    nutrition: dict[str, int | float | str | None]
    ingredients_raw: str | None
    verdicts: list[dict]
    advisories: list[dict]
    ocr_backend: Literal["paddleocr", "gemini", "offline"]
    image_quality: dict[str, float | bool]
