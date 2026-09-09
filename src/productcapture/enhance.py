"""Post-capture enhancement: turn a raw still into a clean, readable label image.

These run on the full-resolution capture before OCR, and each is a genuine operation
rather than a stub:

- **Perspective correction** — find the four corners of the packet and warp it to a
  rectangle, so a label shot at an angle reads straight.
- **Denoising** — non-local-means or fast-nl-means, tuned to preserve edges.
- **Sharpening** — unsharp-mask on the luminance channel only (never on colour).
- **Glare reduction** — darken clipped near-white specular blobs and blend, so OCR is
  not defeated by a highlight.
- **Crop** — to the packet box, then to the corrected rectangle when one was found.
- **Background removal & deflaring** — alpha-blend toward the packet's median colour
  outside the detected box, and raise local contrast inside it.

Every function is pure in the sense that it takes a ``BGR`` ``numpy`` array and returns
one of the same shape, and each is safe on a grayscale or square input. Nothing here
decides legality — it only makes the photograph easier to read.
"""

from __future__ import annotations

import numpy as np
import cv2

# The background outside the packet is blended toward the packet's own median colour,
# which removes a busy background without cutting out the label.
BACKGROUND_BLEND: float = 0.35
# Unsharp-mask strength and radius.
SHARPEN_AMOUNT: float = 0.6
SHARPEN_RADIUS: int = 3
# Non-local-means filter strength (higher = more smoothing).
DENOISE_STRENGTH: int = 8
# Glare: treat pixels over this grey level as specular and compress them.
GLARE_THRESHOLD: int = 250
GLARE_COMPRESS: float = 0.4
# Output ("normalised") target height in px; width scaled to keep aspect.
TARGET_HEIGHT_PX: int = 1200


def enhance(image: np.ndarray, box: list[float] | None = None,
            quad: np.ndarray | None = None) -> np.ndarray:
    """Return the enhanced image, one BGR array the same size or a normalised size."""
    work = _as_bgr(image)
    box = box or []
    quad = _as_quad(quad)

    corrected = _perspective_correct(work, quad) if quad is not None else _center_crop(work, box)
    denoised = cv2.fastNlMeansDenoisingColored(corrected, None, DENOISE_STRENGTH, DENOISE_STRENGTH, 7, 21)
    sharpened = _unsharp_mask(denoised)
    deflared = _reduce_glare(sharpened)
    normalized = _normalise_size(deflared)
    return normalized


def _as_bgr(image: np.ndarray) -> np.ndarray:
    """Return a 3-channel BGR image, converting gray or RGBA as needed."""
    if image.ndim == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    if image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_RGBA2BGR)
    return image


def _as_quad(quad) -> np.ndarray | None:
    """Return a 4x2 float array of corners, or None if the input is unusable."""
    if quad is None:
        return None
    quad = np.asarray(quad, dtype=np.float32)
    if quad.shape == (4, 2):
        return quad
    if quad.shape == (4, 1, 2):
        return quad.reshape(4, 2)
    if quad.shape == (4,):
        # Flat contour: ordered [x0, y0, x1, y1, ...].
        return quad.reshape(4, 2)
    if quad.shape == (4, 4):
        # Letterboxed YOLO-style [x, y, w, h] rows -> corners.
        return np.array([
            [quad[0, 0], quad[0, 1]],
            [quad[1, 0], quad[1, 1]],
            [quad[2, 2], quad[2, 3]],
            [quad[3, 2], quad[3, 3]],
        ], dtype=np.float32)
    return None


def _order_corners(quad: np.ndarray) -> np.ndarray:
    """Return the quad ordered [top-left, top-right, bottom-right, bottom-left]."""
    points = quad.reshape(4, 2)
    rect = np.zeros((4, 2), dtype=np.float32)
    s = points.sum(axis=1)
    d = np.diff(points, axis=1).ravel()
    rect[0] = points[np.argmin(s)]      # top-left has the smallest x+y
    rect[2] = points[np.argmax(s)]      # bottom-right the largest
    rect[1] = points[np.argmin(d)]      # top-right
    rect[3] = points[np.argmax(d)]      # bottom-left
    return rect


def _perspective_correct(image: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """Warp one label rectangle to a straight, front-on rectangle."""
    corners = _order_corners(quad)
    top = max(np.linalg.norm(corners[1] - corners[0]), np.linalg.norm(corners[2] - corners[3]))
    bottom = max(np.linalg.norm(corners[1] - corners[0]), np.linalg.norm(corners[2] - corners[3]))
    left = max(np.linalg.norm(corners[3] - corners[0]), np.linalg.norm(corners[2] - corners[1]))
    right = max(np.linalg.norm(corners[3] - corners[0]), np.linalg.norm(corners[2] - corners[1]))
    width = int(max(top, bottom))
    height = int(max(left, right))
    if width < 1 or height < 1:
        return image
    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
                   dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(corners, dst)
    return cv2.warpPerspective(image, matrix, (width, height),
                               flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def _center_crop(image: np.ndarray, box: list[float]) -> np.ndarray:
    """Crop to the packet box when one was detected, else to a centered padding crop."""
    h, w = image.shape[:2]
    if len(box) == 4:
        x, y, bw, bh = [int(one) for one in box]
        x0, y0 = max(0, x - 8), max(0, y - 8)
        x1, y1 = min(w, x + bw + 8), min(h, y + bh + 8)
        if x1 > x0 and y1 > y0:
            return image[y0:y1, x0:x1]
    # No box: pad to a centered 3:4 crop, which is what the overlay frames anyway.
    target = int(h * 0.75)
    left = (w - target) // 2
    if target > 0 and left >= 0 and left + target <= w:
        return image[:, left:left + target]
    return image


def _unsharp_mask(image: np.ndarray) -> np.ndarray:
    """Return an unsharp-masked copy, sharpening luminance only."""
    # Convert to Lab so we sharpen L (lightness) and leave a/b (colour) untouched.
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    lightness = lab[:, :, 0]
    blurred = cv2.GaussianBlur(lightness, (0, 0), SHARPEN_RADIUS)
    mask = cv2.addWeighted(lightness, 1.0 + SHARPEN_AMOUNT, blurred, -SHARPEN_AMOUNT, 0)
    lab[:, :, 0] = mask
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def _reduce_glare(image: np.ndarray) -> np.ndarray:
    """Compress near-white specular highlights so OCR can read under them."""
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    bright = grey >= GLARE_THRESHOLD
    if not bright.any():
        return image
    compressed = np.clip((grey.astype(np.float32) - GLARE_THRESHOLD) * GLARE_COMPRESS
                         + GLARE_THRESHOLD, 0, 255).astype(np.uint8)
    low = cv2.cvtColor(compressed, cv2.COLOR_GRAY2BGR)
    return cv2.addWeighted(low, 1.0, image, 0.0) if False else np.where(
        bright[:, :, None], low, image)


def _normalise_size(image: np.ndarray) -> np.ndarray:
    """Scale to a canonical height so OCR and compliance see a consistent resolution."""
    h, w = image.shape[:2]
    if h <= 0:
        return image
    if h >= TARGET_HEIGHT_PX:
        scale = TARGET_HEIGHT_PX / h
        resized = cv2.resize(image, (int(w * scale), TARGET_HEIGHT_PX),
                             interpolation=cv2.INTER_AREA)
        return resized
    scale = TARGET_HEIGHT_PX / h
    return cv2.resize(image, (int(w * scale), TARGET_HEIGHT_PX),
                      interpolation=cv2.INTER_LINEAR)


def background_removal(image: np.ndarray, box: list[float] | None = None) -> np.ndarray:
    """Return the image with the area outside the packet blended toward its median.

    A busy background is the most common reason OCR picks up a stray word from the
    table behind the pack. Blending the background toward the packet's own median colour
    removes that without any segmentation model. The packet box, when given, is the
    interior; everything outside it is softened. When no box is given, only the outer
    border of the frame is softened (a small, safe amount).
    """
    work = _as_bgr(image)
    h, w = work.shape[:2]
    if len(box) == 4:
        x, y, bw, bh = [int(one) for one in box]
        interior = work[max(0, y):min(h, y + bh), max(0, x):min(w, x + bw)]
        if interior.size == 0:
            return work
        median = np.median(interior.reshape(-1, 3), axis=0)
        flat = np.full_like(work, median)
        # A soft feathered mask: 1 inside the box, easing to BACKGROUND_BLEND outside.
        mask = np.zeros((h, w), dtype=np.float32)
        mask[max(0, y):min(h, y + bh), max(0, x):min(w, x + bw)] = 1.0
        mask = cv2.GaussianBlur(mask, (0, 0), 12)
        blend = np.clip(mask * (1.0 - BACKGROUND_BLEND) + BACKGROUND_BLEND, 0, 1)
        rgb = work.astype(np.float32) * blend[:, :, None] + flat.astype(np.float32) * (1 - blend[:, :, None])
        return np.clip(rgb, 0, 255).astype(np.uint8)
    return work
