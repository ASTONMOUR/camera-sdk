"""Quality assessment of one photograph, in 0.0..1.0 where a range applies.

This is the server-side twin of ``web/core/quality.js``. The worker runs the same
scores live so the overlay can guide the user before capture; this module re-scores the
captured still so the compliance report can trust a number that was not derived from a
low-resolution preview. The metrics are the ones the spec names — blur, brightness,
exposure, glare/reflection, and the "is this a fair photograph of one packet" questions
(present, centered, right size, not perspective-warped, not duplicated).

A frame is ``ready`` only when every gate passes. The reasons list names every failing
gate, so the UI can say exactly what is wrong rather than a single vague "not ready".
Nothing here judges legality; it judges whether the photograph is usable for reading.
"""

from __future__ import annotations

import numpy as np
import cv2

# Blur: variance of a 5x5 Laplacian is large for a sharp image. Values are normalized
# against this reference drawn from phone captures; retune against a device that reads
# consistently soft.
SHARP_VARIANCE_REF: float = 200.0

# A photograph is too dark to read below this mean grey level (0..255).
MIN_MEAN_GREY: float = 60.0
# And blown out above this one.
MAX_MEAN_GREY: float = 245.0

# A specular reflection is a bright blob well above the surrounding label. Flag as glare
# when more than this fraction of the frame sits at or above a near-white level.
GLARE_GREY_LEVEL: int = 250
MAX_GLARE_FRACTION: float = 0.05

# Motion blur is estimated by comparing consecutive frames from the same stream. Beyond
# this mean absolute difference the user is moving the pack and the frame is blurry.
MOTION_BLUR_THRESHOLD: float = 6.0

# A packet "fills the frame" to be usable, but not so much it is cropped. The area
# fraction of the detected packet against the view must fall in this band.
MIN_PACKET_AREA_FRACTION: float = 0.20
MAX_PACKET_AREA_FRACTION: float = 0.92

# The detected bounding box must sit inside the middle band of the frame, so the packet
# is neither against the edge (risking crop) nor merely passing through.
CENTER_BAND_FRACTION: float = 0.30

# Perspective distortion: the ratio of the widest to the narrowest edge of the detected
# quad. Above this the label is too foreshortened to read.
MAX_PERSPECTIVE_RATIO: float = 1.35

# A reflection is a *localized* bright region — a small connected blob of near-white
# whose mean is far above the surrounding label. This is the area window, as a fraction
# of the frame, that qualifies as "localized" rather than "the whole pack is white".
MIN_REFLECTION_AREA_FRACTION: float = 0.0005
MAX_REFLECTION_AREA_FRACTION: float = 0.08

# Duplicate capture: mean absolute difference between a just-captured still and the
# previous one for the same surface. Below this they are the same photograph.
DUPLICATE_DIFFERENCE: float = 1.0

# A normalized reflection-free blur "here" ceiling: the auto-capture gate treats a frame
# as too soft when its blur score (0=sharp, 1=max blur) exceeds this.
MAX_READABLE_BLUR: float = 0.6


def _laplacian_blur(grey: np.ndarray) -> float:
    """Return a 0.0..1.0 blur score, where 1.0 is maximally blurred."""
    variance = float(cv2.Laplacian(grey, cv2.CV_64F).var())
    return SHARP_VARIANCE_REF / (SHARP_VARIANCE_REF + variance)


def _glare_fraction(image: np.ndarray) -> float:
    """Return the fraction of near-white pixels, the signature of a blown highlight."""
    grey = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return float((grey >= GLARE_GREY_LEVEL).mean())


def _is_reflection(grey: np.ndarray, glare: float) -> bool:
    """Return True when a localized bright blob sits inside the frame.

    A pure glare-fraction catches sun on a matte label. A reflection differs in that it
    is a small *disconnected* window of near-white whose mean is far above the frame's
    own mean — the polished logo catching the light, not a white label. We detect that
    as a connected bright component of small area with a high interior brightness.
    """
    if glare <= 0.005:
        return False
    bright = (grey >= int(grey.mean()) + 60).astype(np.uint8)
    components = cv2.connectedComponentsWithStats(bright, 8)
    num, _labels, stats, _centroids = components
    frame_area = float(grey.size)
    frame_mean = float(grey.mean())
    for index in range(1, num):
        area = float(stats[index, cv2.CC_STAT_AREA])
        fraction = area / frame_area
        if not (MIN_REFLECTION_AREA_FRACTION <= fraction <= MAX_REFLECTION_AREA_FRACTION):
            continue
        x, y, w, h = stats[index, cv2.CC_STAT_LEFT], stats[index, cv2.CC_STAT_TOP], \
            stats[index, cv2.CC_STAT_WIDTH], stats[index, cv2.CC_STAT_HEIGHT]
        if w <= 0 or h <= 0:
            continue
        # The component's own mean grey. A real reflection is much brighter than the
        # frame it sits in; a white area of the label is not.
        component = grey[y:y + h, x:x + w]
        if float(component.mean()) > frame_mean + 40:
            return True
    return False


def _packet_geometry(box: list[float], frame_size: tuple[int, int]) -> dict[str, float]:
    """Return area fraction and centered flag for a detected packet box.

    ``box`` is [x, y, w, h] in pixels; ``frame_size`` is (width, height).
    """
    width, height = frame_size
    if width <= 0 or height <= 0 or len(box) != 4:
        return {"area_fraction": 0.0, "centered": False}
    x, y, w, h = box
    clamped = max(0.0, min(w / width, 1.0)) * max(0.0, min(h / height, 1.0))
    cx = (x + w / 2.0) / width
    cy = (y + h / 2.0) / height
    band = CENTER_BAND_FRACTION
    centered = band / 2.0 < cx < 1.0 - band / 2.0 and band / 2.0 < cy < 1.0 - band / 2.0
    return {"area_fraction": clamped, "centered": centered}


def _perspective_ratio(quad: np.ndarray | None) -> float | None:
    """Return the widest/narrowest edge ratio of a quad, or None if degenerate."""
    if quad is None or len(quad) < 4:
        return None
    points = quad.reshape(4, 2).astype(float)
    lengths = []
    for index in range(4):
        nxt = (index + 1) % 4
        side = float(np.linalg.norm(points[nxt] - points[index]))
        lengths.append(side)
    return max(lengths) / max(1e-6, min(lengths))


def assess_quality(
    image: np.ndarray,
    box: list[float] | None = None,
    motion: float | None = None,
    previous: np.ndarray | None = None,
    quad: np.ndarray | None = None,
) -> dict:
    """Assess one frame or still and return a quality dict.

    ``box`` is the packet bounding box when a detector ran; ``motion`` is a mean absolute
    frame-difference the caller computed against a prior frame; ``previous`` the prior
    frame for a duplicate check; ``quad`` an optional detected quad for perspective.
    """
    grey = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mean_grey = float(grey.mean())
    blur = _laplacian_blur(grey)
    glare = _glare_fraction(grey)
    reflection = _is_reflection(grey, glare)
    frame_size = (int(grey.shape[1]), int(grey.shape[0]))

    exposure_good = MIN_MEAN_GREY <= mean_grey <= MAX_MEAN_GREY
    brightness = mean_grey / 255.0

    geometry = _packet_geometry(box or [], frame_size)
    packet_present = box is not None and len(box) == 4
    packet_centered = geometry["centered"]
    area_fraction = geometry["area_fraction"]
    packet_size_ok = MIN_PACKET_AREA_FRACTION <= area_fraction <= MAX_PACKET_AREA_FRACTION

    perspective_ratio = _perspective_ratio(quad)
    perspective_ok = perspective_ratio is None or perspective_ratio <= MAX_PERSPECTIVE_RATIO

    duplicate = False
    if previous is not None and previous.shape == image.shape:
        difference = float(cv2.absdiff(previous, image).mean())
        duplicate = difference < DUPLICATE_DIFFERENCE
    if motion is None:
        motion = 0.0
    motion_blurry = motion > MOTION_BLUR_THRESHOLD

    reasons: list[str] = []
    if blur > MAX_READABLE_BLUR:
        reasons.append("Too blurry")
    if not exposure_good:
        reasons.append("Too dark" if mean_grey < MIN_MEAN_GREY else "Overexposed")
    if glare > MAX_GLARE_FRACTION:
        reasons.append("Increase lighting" if glare > MAX_GLARE_FRACTION else "Reduce reflection")
    if reflection:
        reasons.append("Reflection detected")
    if motion_blurry:
        reasons.append("Hold steady")
    if not packet_present:
        reasons.append("No packet")
    if packet_present and not packet_centered:
        reasons.append("Center the packet")
    if packet_present and not packet_size_ok:
        if area_fraction < MIN_PACKET_AREA_FRACTION:
            reasons.append("Move closer")
        else:
            reasons.append("Move further")
    if perspective_ratio is not None and not perspective_ok:
        reasons.append("Reduce perspective distortion")

    return {
        "blur": round(blur, 3),
        "brightness": round(brightness, 3),
        "exposure_good": exposure_good,
        "glare": round(glare, 3),
        "reflection": reflection,
        "motion": round(motion, 3),
        "sharpness": round(1.0 - blur, 3),
        "packet_present": packet_present,
        "packet_centered": packet_centered,
        "packet_size_ok": packet_size_ok,
        "perspective_ok": perspective_ok,
        "multiple_packets": False,
        "duplicate": duplicate,
        "ready": not reasons,
        "reasons": reasons,
    }


def mean_abs_difference(first: np.ndarray, second: np.ndarray) -> float:
    """Return the mean absolute difference between two same-sized images."""
    if first.shape != second.shape:
        return float("inf")
    return float(cv2.absdiff(first, second).mean())
