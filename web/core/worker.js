// The analysis Web Worker.
//
// Everything expensive per frame happens here so the main thread never drops a
// paint: greyscale downsample, Sobel projection detection, quality gates and
// guidance ranking. The main thread only grabs pixels and draws the overlay.
//
// Protocol:
//   in  { type: "frame", rgba, width, height, seq }   (rgba is transferred)
//   out { type: "analysis", ...analysis, seq, latency_ms }
//   in  { type: "reset" }  — clear the motion reference between surfaces

import { detectFrame, toWorkingGrey } from "./detect.js";
import { assessQuality } from "./quality.js";
import { guidanceFor } from "./guidance.js";

// Previous working-resolution frame, for the motion-blur estimate.
let previous = null;

self.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === "reset") {
    previous = null;
    return;
  }

  if (msg.type !== "frame") return;

  const started = performance.now();
  const rgba = new Uint8ClampedArray(msg.rgba);

  // One working buffer, shared by detection and quality, so the box coordinates
  // and the sampled pixels are in the same space. Getting this wrong was a real
  // bug: detection at full res + quality at 320px silently sampled the wrong
  // region and every frame read as blurry.
  const { grey, w, h, scale } = toWorkingGrey(rgba, msg.width, msg.height);

  const detection = detectFrame(grey, w, h);
  const quality = assessQuality({ grey, width: w, height: h }, previous, detection, null);
  const guidance = guidanceFor(quality);

  previous = grey;

  self.postMessage({
    type: "analysis",
    seq: msg.seq,
    // Box stays in working coords; the overlay multiplies by 1/scale to draw.
    box: detection.box,
    center: detection.center,
    confidence: detection.confidence,
    // Rectangularity. Exposed so the threshold can be calibrated by reading the
    // live number off a real device rather than guessed at.
    alignment: detection.alignment,
    angle: detection.angle,
    area: detection.area,
    aspect_ratio: detection.aspect_ratio,
    distance_cm: detection.distance_cm,
    quality,
    guide: guidance.code,
    label: guidance.text,
    border: guidance.border,
    // Inverse of the downsample factor — display px per working px.
    display_scale: 1 / scale,
    latency_ms: Math.round((performance.now() - started) * 10) / 10,
  });
};
