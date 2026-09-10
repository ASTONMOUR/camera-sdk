"""Tests for the productcapture SDK package.

The suite exercises the package as a black box: start a session, drive the
capture pipeline on synthetic images, and assert on both the wire responses and
the internal metrics. Everything runs without network, without a model file, and
without PaddleOCR — the adapters fall back exactly as they must when absent.
"""

from __future__ import annotations

import base64

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from productcapture.capture import build_plan, surface_for_slot, surfaces_for_shape
from productcapture.enhance import enhance
from productcapture.quality import assess_quality
from productcapture.vision import detect_packet


# --------------------------------------------------------------------------- capture plan

class TestPlan:
    def test_flat_shape_two_surfaces(self):
        plan = build_plan("flat")
        assert plan["shape"] == "flat"
        assert plan["steps"] == ["front", "back"]
        assert plan["total_steps"] == 2

    def test_cylindrical_shape_six_slots(self):
        plan = build_plan("cylindrical")
        assert plan["steps"] == ["front", "side_1", "back", "side_2", "top", "base"]
        assert plan["total_steps"] == 6
        assert len(plan["between"]) == 5

    def test_cylindrical_slots_are_unique(self):
        # The two sides must be distinct slots. When they were both named "side",
        # the second capture silently overwrote the first on disk.
        steps = build_plan("cylindrical")["steps"]
        assert len(steps) == len(set(steps))

    def test_slots_map_onto_labelcheck_surfaces(self):
        # Slots are the capture flow's vocabulary; surfaces are the rule engine's.
        assert surface_for_slot("side_1") == "side"
        assert surface_for_slot("side_2") == "side"
        assert surface_for_slot("top") == "base"
        assert surface_for_slot("front") == "front"
        assert surface_for_slot("nonsense") == "unknown"

    def test_between_instructions(self):
        plan = build_plan("cylindrical")
        # Turning steps say rotate; the lid and base are reached by tilting.
        assert plan["between"][0] == "Rotate the pack 90° and continue."
        assert plan["between"][-2] == "Tilt the pack to photograph the lid."
        assert plan["between"][-1] == "Tilt the pack to photograph the base."

    def test_surfaces_for_shape_flat(self):
        assert surfaces_for_shape("flat") == ("front", "back")

    def test_surfaces_for_shape_cylindrical(self):
        assert surfaces_for_shape("cylindrical") == (
            "front", "side_1", "back", "side_2", "top", "base",
        )

    def test_unknown_shape_falls_back_to_flat(self):
        # An unrecognised shape is treated as flat (two faces) rather than raising,
        # so a future shape name does not brick the whole overlay.
        assert surfaces_for_shape("tetrahedron") == ("front", "back")


# --------------------------------------------------------------------------- a synthetic pack

def make_packet_image(
    *,
    bright: bool = True,
    sharp: bool = True,
    centered: bool = True,
    big: bool = True,
) -> np.ndarray:
    """Return a synthetic 600x800 label image whose aggregate quality varies by flag."""
    grey = 220 if bright else 40
    img = np.full((600, 800, 3), grey, np.uint8)
    if big:
        x0, y0, x1, y1 = 150, 100, 650, 500
    else:
        x0, y0, x1, y1 = 300, 250, 500, 350
    cv2.rectangle(img, (x0, y0), (x1, y1), (40, 160, 200), -1)
    cv2.putText(img, "Jeera Powder", (180, 200), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 0), 3)
    cv2.putText(img, "MRP Rs. 55", (180, 280), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    cv2.putText(img, "Net Wt 100g", (180, 340), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    cv2.putText(img, "FSSAI 10012345678901", (180, 400), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
    if not sharp:
        img = cv2.GaussianBlur(img, (31, 31), 0)
    return img


# --------------------------------------------------------------------------- detection

class TestDetectPacket:
    def test_detects_a_packet_when_present(self):
        image = make_packet_image()
        result = detect_packet(image)
        assert result["confidence"] > 0.4
        assert len(result["box"]) == 4

    def test_no_packet_on_blank_frame(self):
        image = np.full((600, 800, 3), 128, np.uint8)
        result = detect_packet(image)
        assert result["confidence"] < 0.5

    def test_box_is_inside_frame(self):
        image = make_packet_image()
        box = detect_packet(image)["box"]
        h, w = image.shape[:2]
        x, y, bw, bh = box
        assert 0 <= x < w and 0 <= y < h
        assert bw > 0 and bh > 0

    def test_a_person_is_not_a_packet(self):
        """A head-and-shoulders silhouette is large, central, and not a pack.

        This is the false positive that shipped: the browser fired the shutter at
        people standing in frame, because "biggest central blob" describes a person
        perfectly. The server detector had the same hole.
        """
        image = np.full((600, 800, 3), 220, np.uint8)
        cv2.ellipse(image, (400, 230), (90, 120), 0, 0, 360, (60, 70, 90), -1)   # head
        cv2.ellipse(image, (400, 560), (210, 220), 0, 180, 360, (60, 70, 90), -1)  # shoulders
        assert detect_packet(image)["box"] == []

        # And prove it is the extent gate rejecting it, not some incidental filter —
        # otherwise this test would keep passing after the gate was removed.
        import productcapture.vision as vision

        original = vision.MIN_RECT_EXTENT
        try:
            vision.MIN_RECT_EXTENT = 0.0
            assert detect_packet(image)["box"] != []
        finally:
            vision.MIN_RECT_EXTENT = original


# --------------------------------------------------------------------------- quality

class TestAssessQuality:
    def test_ready_when_well_placed(self):
        image = make_packet_image()
        q = assess_quality(image, box=[150, 100, 500, 400], motion=0.0)
        assert q["ready"] is True

    def test_blurry_image_reported(self):
        image = make_packet_image(sharp=False)
        q = assess_quality(image, box=[150, 100, 500, 400], motion=0.0)
        assert q["sharpness"] < 0.5

    def test_packet_too_small_reasons(self):
        image = make_packet_image(big=False)
        q = assess_quality(image, box=[300, 250, 200, 100], motion=0.0)
        assert q["packet_size_ok"] is False

    def test_critical_reasons_are_human_readable(self):
        image = make_packet_image(big=False)
        q = assess_quality(image, box=[300, 250, 200, 100], motion=0.0)
        assert all(isinstance(r, str) for r in q["reasons"])


# --------------------------------------------------------------------------- enhance

class TestEnhance:
    def test_enhance_normalises_to_1200px_height(self):
        image = make_packet_image()
        out = enhance(image, box=[150, 100, 500, 400])
        # enhancement normalises to a fixed long-edge target (1200 px), so the
        # output may be larger than the input but keeps the same aspect ratio.
        assert out.shape[0] > 0
        assert out.shape[0] == 1200

    def test_perspective_correction_on_tilted_quad(self):
        image = make_packet_image()
        quad = np.array([[160, 90], [640, 120], [655, 495], [145, 485]])
        out = enhance(image, quad=quad)
        assert out is not None and out.size > 0


# --------------------------------------------------------------------------- app flow

def test_full_capture_to_compliance_flow(tmp_path, monkeypatch):
    """Session -> capture -> compliance returns an engine adjudication."""
    monkeypatch.setenv("PRODUCTCAPTURE_SESSION_DIR", str(tmp_path))
    from productcapture.app import create_app

    client = TestClient(create_app())

    # health
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["compliance_rules"] >= 20

    # session
    r = client.post("/api/session", json={"shape": "flat"})
    assert r.status_code == 200
    session = r.json()
    sid = session["session_id"]
    assert session["steps"] == ["front", "back"]

    # capture two surfaces
    image = make_packet_image()
    b64 = base64.b64encode(cv2.imencode(".jpg", image)[1].tobytes()).decode()
    for slot in ("front", "back"):
        r = client.post(
            "/api/capture",
            json={"session_id": sid, "slot": slot, "image_b64": b64},
        )
        assert r.status_code == 200
        assert r.json()["stored"] is True

    # session should now report complete
    r = client.get(f"/api/session/{sid}")
    assert r.status_code == 200
    assert r.json()["complete"] is True

    # compliance
    r = client.post("/api/compliance", json={"session_id": sid})
    assert r.status_code == 200
    report = r.json()
    assert report["session_id"] == sid
    assert report["surfaces_captured"] == ["front", "back"]
    assert report["worst"] in ("PASS", "FAIL", "REVIEW", "INCOMPLETE", "UNREADABLE",
                               "CANNOT_COMPUTE")
    assert "summary" in report
    assert "fields" in report
    assert "verdicts" in report

    # stored result retrievable
    r = client.get(f"/api/compliance/{sid}")
    assert r.status_code == 200
    assert r.json() == report


def test_incomplete_session_reports_not_complete(tmp_path, monkeypatch):
    monkeypatch.setenv("PRODUCTCAPTURE_SESSION_DIR", str(tmp_path))
    from productcapture.app import create_app

    client = TestClient(create_app())
    r = client.post("/api/session", json={"shape": "flat"})
    sid = r.json()["session_id"]
    r = client.get(f"/api/session/{sid}")
    assert r.json()["complete"] is False


def test_cylindrical_keeps_both_sides_on_disk(tmp_path, monkeypatch):
    """Every slot gets its own file.

    Regression guard: when the two sides of a cylinder were both called "side",
    the second capture overwrote the first and the pack was adjudicated with one
    face missing and no error anywhere.
    """
    monkeypatch.setenv("PRODUCTCAPTURE_SESSION_DIR", str(tmp_path))
    from productcapture.app import create_app

    client = TestClient(create_app())
    sid = client.post("/api/session", json={"shape": "cylindrical"}).json()["session_id"]

    image = make_packet_image()
    b64 = base64.b64encode(cv2.imencode(".jpg", image)[1].tobytes()).decode()
    slots = build_plan("cylindrical")["steps"]
    for slot in slots:
        r = client.post(
            "/api/capture",
            json={"session_id": sid, "slot": slot, "image_b64": b64},
        )
        assert r.status_code == 200, r.text

    stored = sorted(p.stem for p in (tmp_path / sid).glob("*.jpg"))
    assert stored == sorted(slots)
    assert client.get(f"/api/session/{sid}").json()["complete"] is True

    # Both sides adjudicate as the "side" surface even though they are apart on disk.
    assert client.post("/api/capture", json={
        "session_id": sid, "slot": "side_2", "image_b64": b64,
    }).json()["surface"] == "side"


def test_capture_to_unknown_session_returns_404(tmp_path, monkeypatch):
    monkeypatch.setenv("PRODUCTCAPTURE_SESSION_DIR", str(tmp_path))
    from productcapture.app import create_app

    client = TestClient(create_app())
    image = make_packet_image()
    b64 = base64.b64encode(cv2.imencode(".jpg", image)[1].tobytes()).decode()
    r = client.post(
        "/api/capture",
        json={"session_id": "no-such-session", "slot": "front", "image_b64": b64},
    )
    assert r.status_code == 404


def test_compliance_without_session_returns_404(tmp_path, monkeypatch):
    monkeypatch.setenv("PRODUCTCAPTURE_SESSION_DIR", str(tmp_path))
    from productcapture.app import create_app

    client = TestClient(create_app())
    r = client.post("/api/compliance", json={"session_id": "nope"})
    assert r.status_code == 404


def test_capture_rejects_bad_image(tmp_path, monkeypatch):
    """A non-image payload is rejected with a 400 rather than crashing."""
    monkeypatch.setenv("PRODUCTCAPTURE_SESSION_DIR", str(tmp_path))
    from productcapture.app import create_app

    client = TestClient(create_app())
    sid = client.post("/api/session", json={"shape": "flat"}).json()["session_id"]
    r = client.post(
        "/api/capture",
        json={"session_id": sid, "slot": "front", "image_b64": "not-an-image"},
    )
    assert r.status_code in (400, 422)
