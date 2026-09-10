// Self-check for the browser core. Run with:  node web/core/selfcheck.mjs
//
// These modules carry the real per-frame logic — detection, the quality gates,
// guidance ranking, the auto-capture hold — and none of it is exercised by the
// Python suite. This is the smallest thing that fails if that logic breaks.

import assert from "node:assert/strict";

import { detectFrame, toWorkingGrey } from "./detect.js";
import { assessQuality } from "./quality.js";
import { guidanceFor, arrowFor } from "./guidance.js";
import { createAutomaton, STATE } from "./automaton.js";
import { buildPlan, surfacesForShape, nextMissingSlotIndex } from "./plan.js";
import { GUIDE, BORDER, STABLE_FRAMES } from "./constants.js";

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

// A synthetic frame: a bright, textured rectangle on a dark ground, which is
// what the overlay asks the user to produce.
function makeFrame({ width = 640, height = 480, fill = 0.55, offsetX = 0, bright = 200 } = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(0);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  const bw = Math.round(width * Math.sqrt(fill));
  const bh = Math.round(height * Math.sqrt(fill));
  const x0 = Math.round((width - bw) / 2) + offsetX;
  const y0 = Math.round((height - bh) / 2);

  for (let y = y0; y < y0 + bh; y += 1) {
    for (let x = x0; x < x0 + bw; x += 1) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      // Stripes give the region edge energy — a flat patch has no texture and
      // would read as blurry no matter how sharp the optics are.
      const v = (x >> 2) % 2 === 0 ? bright : Math.max(0, bright - 90);
      const p = (y * width + x) * 4;
      rgba[p] = v;
      rgba[p + 1] = v;
      rgba[p + 2] = v;
    }
  }
  return { rgba, width, height };
}

const analyse = (opts) => {
  const f = makeFrame(opts);
  const { grey, w, h } = toWorkingGrey(f.rgba, f.width, f.height);
  const detection = detectFrame(grey, w, h);
  const quality = assessQuality({ grey, width: w, height: h }, null, detection, null);
  return { detection, quality, grey, w, h };
};

console.log("detect");

check("finds a centred pack and reports plausible geometry", () => {
  const { detection } = analyse({});
  assert.equal(detection.box.length, 4, "expected a box");
  assert.ok(detection.confidence > 0.3, `confidence ${detection.confidence} too low`);
  assert.ok(detection.area > 0.2 && detection.area < 0.95, `area ${detection.area}`);
  assert.ok(detection.distance_cm > 0, "distance should be positive");
});

check("box is inside the working buffer, not the source frame", () => {
  const { detection, w, h } = analyse({});
  const [x, y, bw, bh] = detection.box;
  assert.ok(x >= 0 && y >= 0, "box origin must be non-negative");
  assert.ok(x + bw <= w && y + bh <= h, "box must fit the working buffer");
});

check("an empty frame yields no detection", () => {
  const width = 320;
  const height = 240;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(0);
  const { grey, w, h } = toWorkingGrey(rgba, width, height);
  const detection = detectFrame(grey, w, h);
  assert.equal(detection.confidence, 0);
  assert.equal(detection.box.length, 0);
});

check("a level pack reads as roughly level", () => {
  const { detection } = analyse({});
  assert.ok(detection.angle >= 0 && detection.angle <= 45, `angle ${detection.angle} out of range`);
});

console.log("quality");

check("a well-framed pack is ready with no complaints", () => {
  const { quality } = analyse({});
  assert.ok(quality.packet_present, "packet should be present");
  assert.ok(quality.packet_size_ok, "size should be acceptable");
  assert.ok(quality.packet_centered, "should read as centred");
  assert.ok(quality.ready, `not ready: ${quality.reasons.join(", ")}`);
});

check("a small pack asks the user to come closer", () => {
  const { quality } = analyse({ fill: 0.04 });
  assert.equal(quality.ready, false);
  assert.ok(
    quality.reasons.includes(GUIDE.TOO_FAR) || quality.reasons.includes(GUIDE.NO_PACKET),
    `expected a distance complaint, got ${quality.reasons.join(", ")}`
  );
});

check("a dark frame asks for more light", () => {
  const { quality } = analyse({ bright: 40 });
  assert.equal(quality.ready, false);
  assert.ok(quality.reasons.includes(GUIDE.INCREASE_LIGHT), quality.reasons.join(", "));
});

check("an off-centre pack names one axis, never two", () => {
  const { quality } = analyse({ offsetX: 200 });
  const directional = quality.reasons.filter((r) =>
    [GUIDE.MOVE_LEFT, GUIDE.MOVE_RIGHT, GUIDE.MOVE_UP, GUIDE.MOVE_DOWN].includes(r)
  );
  assert.ok(directional.length <= 1, `got ${directional.length} directions: ${directional}`);
});

check("motion against a different previous frame registers", () => {
  const a = makeFrame({});
  const b = makeFrame({ offsetX: 120 });
  const wa = toWorkingGrey(a.rgba, a.width, a.height);
  const wb = toWorkingGrey(b.rgba, b.width, b.height);
  const detection = detectFrame(wb.grey, wb.w, wb.h);
  const still = assessQuality({ grey: wb.grey, width: wb.w, height: wb.h }, wb.grey, detection, null);
  const moved = assessQuality({ grey: wb.grey, width: wb.w, height: wb.h }, wa.grey, detection, null);
  assert.equal(still.motion, 0, "an identical previous frame is zero motion");
  assert.ok(moved.motion > still.motion, "a shifted frame must read as more motion");
});

console.log("guidance");

check("no reasons means ready and green", () => {
  const g = guidanceFor({ reasons: [] });
  assert.equal(g.code, GUIDE.READY);
  assert.equal(g.border, BORDER.GREEN);
});

check("the most blocking reason wins", () => {
  // Both present: "no packet" outranks "hold steady" — there is nothing to steady.
  const g = guidanceFor({ reasons: [GUIDE.HOLD_STEADY, GUIDE.NO_PACKET] });
  assert.equal(g.code, GUIDE.NO_PACKET);
  assert.equal(g.border, BORDER.RED);
});

check("close-but-not-ready is amber, not red", () => {
  assert.equal(guidanceFor({ reasons: [GUIDE.HOLD_STEADY] }).border, BORDER.YELLOW);
});

check("every directional code maps to an arrow", () => {
  assert.equal(arrowFor(GUIDE.MOVE_LEFT), "left");
  assert.equal(arrowFor(GUIDE.MOVE_RIGHT), "right");
  assert.equal(arrowFor(GUIDE.MOVE_UP), "up");
  assert.equal(arrowFor(GUIDE.MOVE_DOWN), "down");
  assert.equal(arrowFor(GUIDE.TOO_FAR), "in");
  assert.equal(arrowFor(GUIDE.TOO_BIG), "out");
  assert.equal(arrowFor(GUIDE.INCREASE_LIGHT), null);
});

console.log("automaton");

const readyFrame = { quality: { ready: true, reasons: [] } };
const badFrame = { quality: { ready: false, reasons: [GUIDE.BLURRY] } };

check("fires only after a full second of ready frames", () => {
  let fired = 0;
  const m = createAutomaton({ onCapture: () => { fired += 1; } });
  for (let i = 0; i < STABLE_FRAMES - 1; i += 1) m.push(readyFrame);
  assert.equal(fired, 0, "must not fire early");
  m.push(readyFrame);
  assert.equal(fired, 1, "must fire on the last frame of the hold");
});

check("one bad frame resets the whole hold", () => {
  let fired = 0;
  const m = createAutomaton({ onCapture: () => { fired += 1; } });
  for (let i = 0; i < STABLE_FRAMES - 1; i += 1) m.push(readyFrame);
  m.push(badFrame);
  assert.equal(m.snapshot().progress, 0, "progress must return to zero");
  m.push(readyFrame);
  assert.equal(fired, 0, "a single good frame after a reset must not fire");
});

check("does not fire twice while the capture is in flight", () => {
  let fired = 0;
  const m = createAutomaton({ onCapture: () => { fired += 1; } });
  for (let i = 0; i < STABLE_FRAMES + 40; i += 1) m.push(readyFrame);
  assert.equal(fired, 1, `fired ${fired} times without finish()`);
  assert.equal(m.snapshot().state, STATE.CAPTURING);
});

check("cooldown after finish blocks an immediate re-fire", () => {
  let fired = 0;
  const m = createAutomaton({ onCapture: () => { fired += 1; } });
  for (let i = 0; i < STABLE_FRAMES; i += 1) m.push(readyFrame);
  m.finish({ done: false });
  for (let i = 0; i < STABLE_FRAMES; i += 1) m.push(readyFrame);
  assert.equal(fired, 1, "cooldown must swallow the frames right after a capture");
});

check("finish({done}) parks the machine for good", () => {
  let fired = 0;
  const m = createAutomaton({ onCapture: () => { fired += 1; } });
  for (let i = 0; i < STABLE_FRAMES; i += 1) m.push(readyFrame);
  m.finish({ done: true });
  for (let i = 0; i < STABLE_FRAMES * 3; i += 1) m.push(readyFrame);
  assert.equal(fired, 1);
  assert.equal(m.snapshot().state, STATE.DONE);
});

console.log("plan");

check("client and server plans agree on slot counts", () => {
  assert.deepEqual(buildPlan("flat").steps, ["front", "back"]);
  assert.deepEqual(
    buildPlan("cylindrical").steps,
    ["front", "side_1", "back", "side_2", "top", "base"]
  );
  assert.equal(buildPlan("cylindrical").between.length, 5);
  assert.deepEqual(surfacesForShape("tetrahedron"), ["front", "back"]);
});

check("cylindrical slots are unique", () => {
  const steps = buildPlan("cylindrical").steps;
  assert.equal(new Set(steps).size, steps.length, "duplicate slots overwrite each other");
});

console.log("capture cursor");

check("the cursor walks forward while nothing is missing", () => {
  const steps = buildPlan("cylindrical").steps;
  const shot = [];
  for (let i = 0; i < steps.length; i += 1) {
    assert.equal(nextMissingSlotIndex(steps, shot), i);
    shot.push({ slot: steps[i] });
  }
  assert.equal(nextMissingSlotIndex(steps, shot), -1, "all captured means done");
});

check("a retake sends the cursor back to that slot, not past it", () => {
  const steps = buildPlan("cylindrical").steps;
  const shot = steps.map((slot) => ({ slot }));

  // Drop the first surface, as retake("front") does.
  const after = shot.filter((c) => c.slot !== "front");
  assert.equal(nextMissingSlotIndex(steps, after), 0);

  // Re-shooting it must finish the session, NOT resume at side_1 and
  // re-capture the four surfaces that already have photographs.
  after.push({ slot: "front" });
  assert.equal(nextMissingSlotIndex(steps, after), -1);
});

check("a retake in the middle does not disturb the slots around it", () => {
  const steps = buildPlan("cylindrical").steps;
  const after = steps.filter((s) => s !== "back").map((slot) => ({ slot }));
  assert.equal(nextMissingSlotIndex(steps, after), steps.indexOf("back"));
});

console.log(`\n${checks} checks passed`);
