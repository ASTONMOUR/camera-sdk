// Shared constants for the capture SDK. Pure data, no imports — the worker and
// the UI both load this, so the two halves can never disagree on a threshold.

export const SHARP_VARIANCE_REF = 200.0;   // Laplacian variance that reads as "sharp"
export const MIN_MEAN_GREY = 60.0;         // overall brightness floor
export const MAX_MEAN_GREY = 245.0;        // overall brightness ceiling
export const GLARE_GREY_LEVEL = 250;       // a pixel this bright counts as a specular hit
export const MAX_GLARE_FRACTION = 0.05;    // >5% blown pixels => glare
export const MOTION_BLUR_THRESHOLD = 6.0;  // mean absolute frame-diff scaled
export const MIN_PACKET_AREA_FRACTION = 0.20;
export const MAX_PACKET_AREA_FRACTION = 0.92;
export const CENTER_BAND_FRACTION = 0.30;  // box center may sit this far from frame center
export const MAX_PERSPECTIVE_RATIO = 1.35; // longest edge / shortest edge of the quad
export const DETECT_CONFIDENCE_MIN = 0.35;

// Rectangularity gate. Edge-energy concentration alone cannot tell a pack from a
// person — a face and torso are a dense pile of edges and score just as high,
// which is what made the camera fire at people standing in frame. A packet has
// one property a person does not: it is bounded by straight, perpendicular
// edges, and its printed text runs along those same axes. PACKET_ALIGNMENT_MIN
// is the fraction of in-box edge energy that must share one orientation (folded
// so perpendicular edges count together) for the region to be a pack at all.
//
// CALIBRATION KNOB, and the only threshold here not yet validated against a
// real camera. On the synthetic frames in selfcheck.mjs a striped rectangle
// scores 0.97 and a person-shaped blob 0.41; a uniform spread would give ~0.28.
// Real optics sit lower than synthetic ones — expect a pack around 0.60-0.85
// and a person around 0.25-0.45. Read the live value off the "rect" figure in
// the stats pill: raise this if people still trigger a capture, lower it if a
// real pack will not detect.
export const PACKET_ALIGNMENT_MIN = 0.55;
export const ALIGNMENT_TOLERANCE_DEG = 12;  // half-width of the orientation window
export const ALIGNMENT_MIN_GRADIENT = 30;   // ignore near-flat pixels as noise

export const STABLE_FRAMES = 25;           // frames the packet must stay "ready" to fire
export const EXPECTED_FPS = 25;

// Guidance codes the overlay maps to a message + border colour.
// RED = invalid now, YELLOW = close, GREEN = ready.
export const GUIDE = {
  NO_PACKET: "no_packet",
  TOO_SMALL: "too_small",
  TOO_BIG: "too_big",
  TOO_CLOSE: "too_close",
  TOO_FAR: "too_far",
  MOVE_LEFT: "move_left",
  MOVE_RIGHT: "move_right",
  MOVE_UP: "move_up",
  MOVE_DOWN: "move_down",
  ROTATE: "rotate",
  INCREASE_LIGHT: "increase_light",
  REDUCE_REFLECTION: "reduce_reflection",
  HOLD_STEADY: "hold_steady",
  BLURRY: "blurry",
  READY: "ready",
};

export const GUIDE_TEXT = {
  [GUIDE.NO_PACKET]: "No packet detected. Bring the pack into view.",
  [GUIDE.TOO_SMALL]: "Move closer so the pack fills the frame.",
  [GUIDE.TOO_BIG]: "Move back — the pack is too large in frame.",
  [GUIDE.TOO_CLOSE]: "Too close. Hold the pack a little further away.",
  [GUIDE.TOO_FAR]: "Too far. Move the pack closer.",
  [GUIDE.MOVE_LEFT]: "Move the packet left.",
  [GUIDE.MOVE_RIGHT]: "Move the packet right.",
  [GUIDE.MOVE_UP]: "Move the packet up.",
  [GUIDE.MOVE_DOWN]: "Move the packet down.",
  [GUIDE.ROTATE]: "Rotate the pack so it is level.",
  [GUIDE.INCREASE_LIGHT]: "Increase lighting — the frame is too dark.",
  [GUIDE.REDUCE_REFLECTION]: "Angle away from the light to reduce glare.",
  [GUIDE.HOLD_STEADY]: "Hold steady…",
  [GUIDE.BLURRY]: "Pack is blurry. Hold steady.",
  [GUIDE.READY]: "Perfect. Holding…",
};

export const BORDER = {
  RED: "#ef4444",
  YELLOW: "#f59e0b",
  GREEN: "#22c55e",
};

// The slots a shape needs, mirroring SURFACE_SEQUENCES on the server. A slot is
// one step of the flow; two slots can share a LabelCheck surface (a cylinder has
// two sides), which is why they are named apart.
export const SURFACE_SEQUENCES = {
  flat: ["front", "back"],
  cylindrical: ["front", "side_1", "back", "side_2", "top", "base"],
};

// What to tell the user each slot is.
export const SLOT_LABEL = {
  front: "Front of pack",
  back: "Back of pack",
  side_1: "First side",
  side_2: "Opposite side",
  top: "Lid / top",
  base: "Base",
};

export const SERVER = {
  // Same origin as the page by default — the FastAPI app serves web/ at /static,
  // so the API is always a sibling of the page. Override for a split deployment.
  origin: "",
};
