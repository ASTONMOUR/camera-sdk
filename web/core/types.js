// Structural types for the capture pipeline. These are documented contracts,
// not schema — the worker and the UI both build/consume these shapes. Keeping
// them in one file means the detection, quality and guidance modules never
// guess a key: a missing key is a bug visible at first run, not a silent NaN.

// Mirrors server-side quality.py. Every score is 0.0..1.0 except the booleans.
export function blankQuality() {
  return {
    blur: 0,
    brightness: 0,
    exposure_good: false,
    glare: 0,
    reflection: false,
    motion: 0,
    sharpness: 0,
    packet_present: false,
    packet_centered: false,
    packet_size_ok: false,
    perspective_ok: false,
    multiple_packets: false,
    duplicate: false,
    ready: false,
    reasons: [],
  };
}

// Mirrors server-side vision.py FrameAnalysis plus the UI-only quad.
export function blankAnalysis() {
  return {
    box: [],        // [x, y, w, h] in video pixels
    center: [],     // [cx, cy]
    confidence: 0,
    angle: 0,
    area: 0,
    aspect_ratio: 0,
    distance_cm: null,
    quad: null,     // 4x2 corner array for perspective correction, or null
    quality: blankQuality(),
    guide: null,    // a GUIDE.* code
    label: "",      // human-readable guide text
    ready: false,   // quality.ready AND guide === READY
    ts: 0,
  };
}
