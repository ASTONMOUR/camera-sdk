// The capture plan the overlay drives. Mirrors server capture.py exactly, so
// the client-side plan (what the user is told to do) and the server-side plan
// (what surfaces the session expects) can never disagree.

import { SURFACE_SEQUENCES } from "./constants.js";

export function surfacesForShape(shape) {
  return SURFACE_SEQUENCES[shape] || SURFACE_SEQUENCES["flat"];
}

export function buildPlan(shape) {
  const steps = [...surfacesForShape(shape)];
  return {
    shape,
    steps,
    total_steps: steps.length,
    between: betweenInstructions(shape, steps),
  };
}

function betweenInstructions(shape, steps) {
  if (shape === "cylindrical") {
    const tilt = {
      top: "Tilt the pack to photograph the lid.",
      base: "Tilt the pack to photograph the base.",
    };
    const out = [];
    for (let i = 0; i < steps.length - 1; i += 1) {
      out.push(tilt[steps[i + 1]] || "Rotate the pack 90° and continue.");
    }
    return out;
  }
  return ["Turn the pack over to photograph the back."];
}
