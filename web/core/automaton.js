// The auto-capture state machine.
//
// The spec is explicit: no shutter button. Capture fires when the pack has been
// continuously ready for one second, and any bad frame resets the count. The
// one-second hold is what stops a frame that is momentarily good — mid-wobble,
// mid-focus-hunt — from being the one we keep.
//
// States: IDLE -> ARMING (counting up) -> CAPTURING -> COOLDOWN -> IDLE.
// COOLDOWN exists so the same pack is not captured twice while the user is
// still moving to the next surface.

import { STABLE_FRAMES } from "./constants.js";

export const STATE = {
  IDLE: "idle",
  ARMING: "arming",
  CAPTURING: "capturing",
  COOLDOWN: "cooldown",
  DONE: "done",
};

// Frames to ignore after a capture, so the next surface gets a clean start.
const COOLDOWN_FRAMES = 20;

export function createAutomaton({ onCapture, stableFrames = STABLE_FRAMES } = {}) {
  let state = STATE.IDLE;
  let stable = 0;
  let cooldown = 0;

  function reset() {
    state = STATE.IDLE;
    stable = 0;
    cooldown = 0;
  }

  // Feed one analysed frame. Returns the current state plus 0..1 progress, which
  // the overlay draws as the capture ring.
  function push(analysis) {
    if (state === STATE.DONE) {
      return snapshot();
    }

    if (state === STATE.COOLDOWN) {
      cooldown -= 1;
      if (cooldown <= 0) {
        state = STATE.IDLE;
        stable = 0;
      }
      return snapshot();
    }

    if (state === STATE.CAPTURING) {
      // The capture callback is async; stay here until finish() is called.
      return snapshot();
    }

    if (analysis.quality && analysis.quality.ready) {
      stable += 1;
      state = STATE.ARMING;
      if (stable >= stableFrames) {
        state = STATE.CAPTURING;
        // Fire once. The caller calls finish() when the still is stored.
        if (typeof onCapture === "function") onCapture(analysis);
      }
    } else {
      // Any bad frame resets the hold. This is the whole point of the machine.
      stable = 0;
      state = STATE.IDLE;
    }
    return snapshot();
  }

  // Called by the pipeline once a capture has been stored, to release the machine.
  function finish({ done = false } = {}) {
    if (done) {
      state = STATE.DONE;
      return snapshot();
    }
    state = STATE.COOLDOWN;
    cooldown = COOLDOWN_FRAMES;
    stable = 0;
    return snapshot();
  }

  function snapshot() {
    return {
      state,
      stable,
      progress: Math.min(1, stable / stableFrames),
      // Seconds remaining in the hold, for the countdown the spec asks for.
      countdown: Math.max(0, Math.ceil((stableFrames - stable) / 25)),
    };
  }

  return { push, finish, reset, snapshot };
}
