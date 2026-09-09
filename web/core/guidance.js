// Turn a quality report into the one instruction worth showing right now.
//
// The overlay shows a single line, not a list. Showing "move left and increase
// lighting and hold steady" at 25fps reads as noise; a KYC camera names one
// correction, the user fixes it, the next one appears. So guidance is ranked:
// the most blocking problem wins, and everything else waits its turn.

import { GUIDE, GUIDE_TEXT, BORDER } from "./constants.js";

// Ranked most-blocking first. There is no point telling someone to hold steady
// while no packet is detected, or to reduce glare while the pack is off-frame.
const PRIORITY = [
  GUIDE.NO_PACKET,
  GUIDE.TOO_FAR,
  GUIDE.TOO_BIG,
  GUIDE.MOVE_LEFT,
  GUIDE.MOVE_RIGHT,
  GUIDE.MOVE_UP,
  GUIDE.MOVE_DOWN,
  GUIDE.INCREASE_LIGHT,
  GUIDE.REDUCE_REFLECTION,
  GUIDE.ROTATE,
  GUIDE.BLURRY,
  GUIDE.HOLD_STEADY,
  GUIDE.READY,
];

// Which codes mean "nothing is wrong, we are counting down" versus "close" versus
// "not usable". Drives the border colour the spec asks for.
const GREEN_CODES = new Set([GUIDE.READY]);
const YELLOW_CODES = new Set([GUIDE.HOLD_STEADY, GUIDE.BLURRY, GUIDE.ROTATE]);

export function guidanceFor(quality) {
  const reasons = quality.reasons || [];
  if (reasons.length === 0) {
    return { code: GUIDE.READY, text: GUIDE_TEXT[GUIDE.READY], border: BORDER.GREEN };
  }
  const code = PRIORITY.find((one) => reasons.includes(one)) || reasons[0];
  return { code, text: GUIDE_TEXT[code] || "Adjust the pack.", border: borderFor(code) };
}

function borderFor(code) {
  if (GREEN_CODES.has(code)) return BORDER.GREEN;
  if (YELLOW_CODES.has(code)) return BORDER.YELLOW;
  return BORDER.RED;
}

// Which arrow the overlay should draw, or null when the correction is not
// directional. Returned separately from the text so the arrow can animate.
export function arrowFor(code) {
  switch (code) {
    case GUIDE.MOVE_LEFT:
      return "left";
    case GUIDE.MOVE_RIGHT:
      return "right";
    case GUIDE.MOVE_UP:
      return "up";
    case GUIDE.MOVE_DOWN:
      return "down";
    case GUIDE.TOO_FAR:
      return "in";
    case GUIDE.TOO_BIG:
      return "out";
    default:
      return null;
  }
}
