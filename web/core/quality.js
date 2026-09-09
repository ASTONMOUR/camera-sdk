// Per-frame quality gates for the Web Worker. This is a JS twin of the
// server's quality.py so the live guidance and the stored assessment agree.
// It receives a greyscale Float array (or the raw RGBA) and the detected box.

import {
  SHARP_VARIANCE_REF,
  MIN_MEAN_GREY,
  MAX_MEAN_GREY,
  GLARE_GREY_LEVEL,
  MAX_GLARE_FRACTION,
  MOTION_BLUR_THRESHOLD,
  MIN_PACKET_AREA_FRACTION,
  MAX_PACKET_AREA_FRACTION,
  CENTER_BAND_FRACTION,
  MAX_PERSPECTIVE_RATIO,
  DETECT_CONFIDENCE_MIN,
  GUIDE,
} from "./constants.js";

export function assessQuality(frame, prev, detection, quad) {
  const { width, height } = frame;
  const grey = frame.grey;
  const reasons = [];

  const meanGrey = mean(grey);
  const brightness = clamp01(meanGrey / 255);

  // Sharpeness = Laplacian variance over the packet region.
  const sharpness = clamp01(laplacianVariance(grey, width, height, detection.box) / SHARP_VARIANCE_REF);
  const blur = 1 - sharpness;

  // Glare: fraction of pixels at or above the specular threshold.
  const glare = glareFraction(grey, width, height, detection.box);
  const reflection = glare > MAX_GLARE_FRACTION;

  // Exposure band.
  const exposure_good = meanGrey >= MIN_MEAN_GREY && meanGrey <= MAX_MEAN_GREY;

  // Motion: mean absolute difference vs previous frame (same size).
  let motion = 0;
  if (prev && prev.length === grey.length) {
    let diff = 0;
    for (let i = 0; i < grey.length; i += 1) {
      diff += Math.abs(grey[i] - prev[i]);
    }
    motion = (diff / grey.length) / MOTION_BLUR_THRESHOLD;
  }

  const packet_present = detection.confidence >= DETECT_CONFIDENCE_MIN;
  const [area, aspect] = [detection.area, detection.aspect_ratio];

  // Geometry gates.
  const packet_size_ok = area >= MIN_PACKET_AREA_FRACTION && area <= MAX_PACKET_AREA_FRACTION;
  const cx = detection.center[0] || width / 2;
  const cy = detection.center[1] || height / 2;
  const centered =
    Math.abs(cx - width / 2) <= width * CENTER_BAND_FRACTION &&
    Math.abs(cy - height / 2) <= height * CENTER_BAND_FRACTION;
  const perspective_ok = quad ? quadPerspectiveOk(quad, width, height) : true;
  const multiple_packets = detection.confidence < 0.7 && detection.area > MAX_PACKET_AREA_FRACTION;
  const duplicate = false; // set by the state machine after a capture, not per-frame

  const ready =
    packet_present &&
    packet_size_ok &&
    centered &&
    perspective_ok &&
    exposure_good &&
    !reflection &&
    sharpness >= 0.6 &&
    motion < 1.0;

  if (!packet_present) reasons.push(GUIDE.NO_PACKET);
  if (packet_present && !packet_size_ok) reasons.push(area < MIN_PACKET_AREA_FRACTION ? GUIDE.TOO_FAR : GUIDE.TOO_BIG);
  if (packet_present && !centered) reasons.push(centerReason(cx, cy, width, height));
  if (!exposure_good) reasons.push(meanGrey < MIN_MEAN_GREY ? GUIDE.INCREASE_LIGHT : GUIDE.REDUCE_REFLECTION);
  if (reflection) reasons.push(GUIDE.REDUCE_REFLECTION);
  if (sharpness < 0.6) reasons.push(GUIDE.BLURRY);
  if (motion >= 1.0) reasons.push(GUIDE.HOLD_STEADY);
  if (perspective_ok === false) reasons.push(GUIDE.ROTATE);

  // A "ready" frame with just one residual reason becomes hold-steady.
  if (ready && reasons.length === 0) reasons.push(GUIDE.READY);

  return {
    blur,
    brightness,
    exposure_good,
    glare,
    reflection,
    motion,
    sharpness,
    packet_present,
    packet_centered: centered,
    packet_size_ok,
    perspective_ok,
    multiple_packets,
    duplicate,
    ready,
    reasons,
  };
}

// Name the single most useful correction rather than all of them at once: the
// axis the packet is furthest off on. Telling someone "move left and up" while
// they are already moving is how a KYC camera feels indecisive.
function centerReason(cx, cy, width, height) {
  const dx = cx - width / 2;
  const dy = cy - height / 2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx > 0 ? GUIDE.MOVE_LEFT : GUIDE.MOVE_RIGHT;
  }
  return dy > 0 ? GUIDE.MOVE_UP : GUIDE.MOVE_DOWN;
}

export function quadPerspectiveOk(quad, width, height) {
  // A 4x2 corner array. Compute the ratio between the longest and shortest
  // edges; a big skew means the pack is at an angle we cannot read.
  const d = [0, 1, 2, 3].map((i) => dist(quad[i], quad[(i + 1) % 4]));
  const longest = Math.max(...d);
  const shortest = Math.min(...d);
  return shortest === 0 || longest / shortest <= MAX_PERSPECTIVE_RATIO;
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i += 1) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

function glareFraction(grey, width, height, box) {
  const region = box && box.length === 4 ? box : [0, 0, width, height];
  const x0 = Math.max(0, Math.round(region[0]));
  const y0 = Math.max(0, Math.round(region[1]));
  const x1 = Math.min(width, Math.round(region[0] + region[2]));
  const y1 = Math.min(height, Math.round(region[1] + region[3]));
  let bright = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (grey[y * width + x] >= GLARE_GREY_LEVEL) bright += 1;
      total += 1;
    }
  }
  return total ? bright / total : 0;
}

function laplacianVariance(grey, width, height, box) {
  // Sample the packet region for a Laplacian; higher variance = more edges =
  // sharper. Skip the one-pixel border where the kernel would read outside.
  const region = box && box.length === 4 ? box : [0, 0, width, height];
  const x0 = Math.max(1, Math.round(region[0]));
  const y0 = Math.max(1, Math.round(region[1]));
  const x1 = Math.min(width - 1, Math.round(region[0] + region[2]));
  const y1 = Math.min(height - 1, Math.round(region[1] + region[3]));
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * width + x;
      const lap =
        4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - width] - grey[i + width];
      sum += lap;
      sumSquares += lap * lap;
      count += 1;
    }
  }
  if (!count) return 0;
  const average = sum / count;
  return sumSquares / count - average * average;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
