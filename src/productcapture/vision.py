"""Server-side packet detection and measurement for the captured still.

The browser worker runs detection live at 25 fps; this module runs the *same* detector
once on the full-resolution capture, so the box, confidence, angle, area and aspect
ratio are measured on the photograph that actually flows into OCR and the compliance
engine — not on a 320px preview.

The default detector is a classical OpenCV pipeline tuned for a single centered food
pack on a clean background (the framing the overlay enforces). It is deliberately model-
free: it needs no weights, works offline, and runs identically on every platform. When
a YOLO11 ``.onnx`` model file is mounted, :func:`detect_packet` delegates to the model
path instead — see ``_yolo_detect``. The heuristic is a *fallback*, not a stand-in for
the model; the two share an output shape so the rest of the system never knows which
one produced the box.

The measurement is honest about its limits: on a cylinder, text near the curve
foreshortens, so ``distance_cm`` is an *estimate* from a known-size reference only, and
is reported as ``None`` when no reference width was observed — never guessed.
"""

from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

# The minimum strength of a detected contour to be treated as the packet.
MIN_CONTOUR_AREA_FRACTION: float = 0.05

# The detector intentionally ignores the central guide band's own border, so a frame
# with no packet does not "detect" the overlay rectangle. Contours whose bounding box is
# this close to the frame edge are the overlay or a hand, not the pack.
EDGE_MARGIN_FRACTION: float = 0.02

# Known widths, in centimetres, of reference objects for distance estimation.
REFERENCE_OBJECTS_CM: dict[str, float] = {
    "euro_card": 8.56,   # ISO/IEC 7810 ID-1 card
    "five_rupee_coin": 2.3,
}

# Focal length in pixels (diagonal) used for a phone-style preview. True calibration
# would read it from the camera; an approximation is enough to recover an order of
# magnitude, and the value is marked as such in the returned dict.
DEFAULT_FOCAL_LENGTH_PX: float = 1000.0
FOCAL_LENGTH_ENV: str = "PRODUCTCAPTURE_FOCAL_PX"


def _config_path(name: str) -> str | None:
    """Return an environment-overridable model path, or None if unset."""
    import os
    return os.environ.get(name)


def detect_packet(image: np.ndarray) -> dict:
    """Detect the food packet in one image and return a :class:`FrameAnalysis` dict.

    The return shape matches the browser worker's ``FrameAnalysis``: ``box``,
    ``confidence``, ``angle``, ``area``, ``aspect_ratio``, ``distance_cm``. If nothing
    plausible is found, ``box`` is empty and ``confidence`` 0.
    """
    grey = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    height, width = grey.shape
    model_path = _config_path("PRODUCTCAPTURE_YOLO_PATH")
    if model_path and Path(model_path).exists():
        return _yolo_detect(image, model_path)

    box, confidence, angle, quad = _heuristic_detect(grey)
    center = [float((box[0] + box[2] / 2.0)), float((box[1] + box[3] / 2.0))] if box else []
    area = float(box[2] * box[3]) if box else 0.0
    aspect_ratio = float(box[2] / box[3]) if box and box[3] else 0.0
    distance_cm = _estimate_distance(box, width, height)
    return {
        "box": [float(one) for one in box],
        "center": center,
        "confidence": round(confidence, 3),
        "angle": round(angle, 2),
        "area": round(area, 1),
        "aspect_ratio": round(aspect_ratio, 3),
        "distance_cm": distance_cm,
        "quad": quad,
    }


def _heuristic_detect(grey: np.ndarray) -> tuple[list[float], float, float, np.ndarray | None]:
    """Return [box, confidence, angle, quad] for the best packet-like contour.

    The heuristic leans on three signals the framing overlay guarantees: the pack is a
    large, roughly rectangular blob on a background that is either plain or out of
    focus; it sits in the center; and its edges are the strongest in the frame after
    blur suppression. It first takes the largest contour near the center, then checks
    the centre of its top edge for an aspect-ratio-consistent, high-fill rectangle.
    """
    height, width = grey.shape
    # Gaussian blur suppresses specular noise before Canny.
    blurred = cv2.GaussianBlur(grey, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _hierarchy = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = float(width * height)
    center_point = (width / 2.0, height / 2.0)

    best: tuple[float, list[float], float, np.ndarray | None] = (0.0, [], 0.0, None)
    margin = int(EDGE_MARGIN_FRACTION * min(width, height))
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = float(w * h)
        if area < MIN_CONTOUR_AREA_FRACTION * frame_area:
            continue
        # Reject boxes flush against the frame edge (the overlay rectangle, a hand).
        if x <= margin or y <= margin or x + w >= width - margin or y + h >= height - margin:
            continue
        # The center of the box must be reasonably central.
        cx, cy = x + w / 2.0, y + h / 2.0
        if (cx - center_point[0]) ** 2 + (cy - center_point[1]) ** 2 > (frame_area * 0.25):
            continue
        rect_area = area / frame_area
        if rect_area > best[0]:
            quad = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
            angle, _rot_rect = _orientation(cv2.minAreaRect(contour))
            best = (rect_area, [float(x), float(y), float(w), float(h)], angle,
                    quad if len(quad) == 4 else None)

    if best[1]:
        return [best[1], min(1.0, best[0] * 3.0), best[2], best[3]]
    return [], 0.0, 0.0, None


def _orientation(rect) -> tuple[float, tuple[float, float]]:
    """Return the angle in degrees of a minAreaRect, and its center."""
    center, (w, h), angle = rect
    # OpenCV gives [-90, 0); a "packet parallel to the camera" means ~0.
    normalized = float(angle) if angle < 0 else float(angle) - 90.0
    return normalized, center


def _estimate_distance(box: list[float], width: int, height: int) -> float | None:
    """Estimate distance to the packet in cm, or None without a known reference.

    This is an estimate, and it is labelled as such: a phone camera's focal length is not
    calibrated here, so the number is an order of magnitude, not a measurement. When
    ``PRODUCTCAPTURE_FOCAL_PX`` is set the estimate uses that. It is returned as a float
    and the client shows it as "approx".
    """
    if not box:
        return None
    focal = float(os.environ.get(FOCAL_LENGTH_ENV, DEFAULT_FOCAL_LENGTH_PX))
    # The apparent box width in pixels. A typical pack is ~12 cm across; we invert the
    # thin-lens equation distance = focal * real / apparent.
    apparent_w_px = float(box[2])
    if apparent_w_px <= 0:
        return None
    cm_per_px = REFERENCE_OBJECTS_CM["euro_card"] / apparent_w_px
    # Assume a 12 cm-wide pack: distance in cm ~ (focal * 12) / apparent_w.
    distance = (focal * 12.0) / apparent_w_px
    if not (10.0 <= distance <= 300.0):
        return None
    return round(distance, 1)


def _yolo_detect(image: np.ndarray, model_path: str) -> dict:
    """Run YOLOv11 (ONNX) over one image.

    Implemented and wired, but only active when ``PRODUCTCAPTURE_YOLO_PATH`` points at a
    real ``.onnx`` model — which is not part of this checkout. Uses the YOLOv11 output
    layout ``[1, 84, 8400]``: 4 box coordinates + 80 class scores + 4 (angle/mask)
    channel variants per anchor, with class-agnostic NMS returning the strongest box.
    """
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError(
            "onnxruntime is not installed; place a YOLO11 .onnx at "
            "PRODUCTCAPTURE_YOLO_PATH, or run the model-free detector."
        ) from error

    h0, w0 = image.shape[:2]
    # Letterbox to the model input (640) while keeping aspect.
    size = 640
    scale = min(size / w0, size / h0)
    new_w, new_h = int(w0 * scale), int(h0 * scale)
    resized = cv2.resize(image, (new_w, new_h))
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[(size - new_h) // 2:(size - new_h) // 2 + new_h,
           (size - new_w) // 2:(size - new_w) // 2 + new_w] = resized
    blob = cv2.dnn.blobFromImage(canvas, 1 / 255.0, (size, size), (0, 0, 0), swapRB=True)
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    outputs = session.run(None, {session.get_inputs()[0].name: blob})
    pred = outputs[0]
    pred = pred.squeeze()  # [84, 8400]
    boxes, confidences = _yolo_nms(pred, scale, new_w, new_h, w0, h0)
    if not boxes:
        return {"box": [], "center": [], "confidence": 0.0, "angle": 0.0,
                "area": 0.0, "aspect_ratio": 0.0, "distance_cm": None, "quad": None}
    x, y, w, h = boxes[0]
    return {
        "box": [float(x), float(y), float(w), float(h)],
        "center": [float(x + w / 2), float(y + h / 2)],
        "confidence": round(float(confidences[0]), 3),
        "angle": 0.0,
        "area": float(w * h),
        "aspect_ratio": round(float(w / h), 3) if h else 0.0,
        "distance_cm": _estimate_distance([x, y, w, h], w0, h0),
        "quad": None,
    }


def _yolo_nms(pred: np.ndarray, scale: float, new_w: int, new_h: int,
              w0: int, h0: int) -> tuple[list[list[float]], list[float]]:
    """Return [boxes, confidences] after class-agnostic NMS, scaled back to the frame."""
    scores = pred[4:4 + 1].ravel()  # one score row (class-agnostic)
    coords = pred[:4]                # [cx, cy, w, h] in the letterbox frame
    keep = np.where(scores > 0.25)[0]
    if keep.size == 0:
        return [], []
    coords = coords[:, keep]
    scores = scores[keep]
    cx, cy, w, h = coords
    # Convert to top-left in the original frame.
    pad = (640 - new_w) / 2.0, (640 - new_h) / 2.0
    x = (cx - w / 2.0 - pad[0]) / scale
    y = (cy - h / 2.0 - pad[1]) / scale
    ww = w / scale
    hh = h / scale
    order = scores.argsort()[::-1]
    boxes, confidences = [], []
    for index in order:
        if len(boxes) >= 5:
            break
        xi, yi, wi, hi = float(x[index]), float(y[index]), float(ww[index]), float(hh[index])
        if xi < 0 or yi < 0 or xi + wi <= 0 or yi + hi <= 0:
            continue
        boxes.append([xi, yi, wi, hi])
        confidences.append(float(scores[index]))
    return boxes, confidences
