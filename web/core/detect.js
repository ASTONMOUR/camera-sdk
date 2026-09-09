// Frame-level packet detection for the Web Worker.
//
// Zero-model path that holds <40ms at 320px working width. The method is a
// projection profile over Sobel edge energy: for a single dominant pack framed
// against a plainer background (which the overlay asks the user to produce),
// the rows and columns the pack occupies carry far more edge energy than the
// background does. Taking the span where energy exceeds a fraction of the peak
// localises the pack without any model, threshold tuning per device, or colour
// assumption.
//
// Tilt comes from the structure tensor's dominant gradient orientation, which
// is the standard cheap way to recover "how rotated is this rectangle" — for a
// level pack, edges concentrate at 0° and 90°, so deviation from that is tilt.

// Fraction of peak row/column energy that still counts as "inside the pack".
const BAND_THRESHOLD = 0.35;
// Reject a detection covering less than this fraction of the frame — noise.
const MIN_AREA_FRACTION = 0.03;
const WORK_WIDTH = 320;

export function detectFrame(grey, w, h) {
  const { gx, gy } = sobel(grey, w, h);

  // Edge magnitude projected onto each axis.
  const colEnergy = new Float32Array(w);
  const rowEnergy = new Float32Array(h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const mag = Math.abs(gx[i]) + Math.abs(gy[i]);
      colEnergy[x] += mag;
      rowEnergy[y] += mag;
    }
  }

  const xs = span(colEnergy);
  const ys = span(rowEnergy);
  if (!xs || !ys) return empty();

  const bw = xs[1] - xs[0];
  const bh = ys[1] - ys[0];
  const areaFraction = (bw * bh) / (w * h);
  if (areaFraction < MIN_AREA_FRACTION) return empty();

  const angle = dominantTilt(gx, gy, w, h, xs, ys);

  // Confidence: how much of the total edge energy falls inside the box. A real
  // pack concentrates its edges there; a noisy frame spreads them everywhere.
  const confidence = energyConcentration(gx, gy, w, h, xs, ys);

  return {
    // Box is in WORKING-resolution pixels. The worker scales it to display
    // coordinates for the overlay; quality.js reads it against the same buffer.
    box: [xs[0], ys[0], bw, bh],
    center: [xs[0] + bw / 2, ys[0] + bh / 2],
    confidence: round(confidence, 3),
    angle: round(angle, 1),
    area: round(areaFraction, 4),
    aspect_ratio: round(bw / Math.max(1, bh), 3),
    // Apparent size shrinks with distance; calibrated so a pack filling ~45% of
    // the frame reads ~20cm, the natural arm's-length framing. Reported as an
    // estimate only — the UI labels it "approx".
    distance_cm: round(20 * Math.sqrt(0.45 / Math.max(areaFraction, 0.01)), 1),
  };
}

// Downsample a camera frame to the working greyscale buffer both detection and
// quality read. Exported so the worker computes it once per frame rather than
// once per consumer.
export function toWorkingGrey(rgba, width, height) {
  const scale = WORK_WIDTH / width;
  const w = WORK_WIDTH;
  const h = Math.max(1, Math.round(height * scale));
  const grey = new Float32Array(w * h);
  // Nearest-neighbour subsample: at this ratio it is visually equivalent to a
  // box filter for edge purposes and costs a fraction as much.
  for (let y = 0; y < h; y += 1) {
    const srcY = Math.min(height - 1, Math.round(y / scale));
    for (let x = 0; x < w; x += 1) {
      const srcX = Math.min(width - 1, Math.round(x / scale));
      const p = (srcY * width + srcX) * 4;
      grey[y * w + x] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    }
  }
  return { grey, w, h, scale };
}

function sobel(grey, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      gx[i] =
        grey[i - w + 1] + 2 * grey[i + 1] + grey[i + w + 1] -
        grey[i - w - 1] - 2 * grey[i - 1] - grey[i + w - 1];
      gy[i] =
        grey[i + w - 1] + 2 * grey[i + w] + grey[i + w + 1] -
        grey[i - w - 1] - 2 * grey[i - w] - grey[i - w + 1];
    }
  }
  return { gx, gy };
}

// Return [start, end] of the contiguous span around the peak whose energy stays
// above BAND_THRESHOLD of the peak. Walking outward from the peak (rather than
// taking every above-threshold index) keeps a bright distractor at the frame
// edge from stretching the box across the whole image.
function span(energy) {
  let peak = 0;
  let peakIndex = -1;
  for (let i = 0; i < energy.length; i += 1) {
    if (energy[i] > peak) {
      peak = energy[i];
      peakIndex = i;
    }
  }
  if (peakIndex < 0 || peak <= 0) return null;

  const floor = peak * BAND_THRESHOLD;
  let start = peakIndex;
  let end = peakIndex;
  while (start > 0 && energy[start - 1] >= floor) start -= 1;
  while (end < energy.length - 1 && energy[end + 1] >= floor) end += 1;
  return end > start ? [start, end] : null;
}

// Structure tensor over the detected region gives the dominant edge orientation.
// Returned as degrees away from level, in 0..45 (a square is symmetric every 90°).
function dominantTilt(gx, gy, w, h, xs, ys) {
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let y = ys[0]; y <= ys[1]; y += 1) {
    for (let x = xs[0]; x <= xs[1]; x += 1) {
      const i = y * w + x;
      sxx += gx[i] * gx[i];
      syy += gy[i] * gy[i];
      sxy += gx[i] * gy[i];
    }
  }
  if (sxx + syy === 0) return 0;
  // Orientation of the dominant gradient, in degrees.
  const orientation = 0.5 * Math.atan2(2 * sxy, sxx - syy) * (180 / Math.PI);
  // Fold into 0..45: edges of a level rectangle sit at multiples of 90°.
  const folded = Math.abs(((orientation % 90) + 90) % 90);
  return folded > 45 ? 90 - folded : folded;
}

function energyConcentration(gx, gy, w, h, xs, ys) {
  let inside = 0;
  let total = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const mag = Math.abs(gx[i]) + Math.abs(gy[i]);
      total += mag;
      if (y >= ys[0] && y <= ys[1] && x >= xs[0] && x <= xs[1]) inside += mag;
    }
  }
  return total > 0 ? inside / total : 0;
}

function empty() {
  return {
    box: [],
    center: [],
    confidence: 0,
    angle: 0,
    area: 0,
    aspect_ratio: 0,
    distance_cm: null,
  };
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
