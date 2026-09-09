// Canvas overlay: the guide rectangle, the live box, the alignment arrow, the
// capture progress ring, the distance readout and the shutter flash.
//
// Drawing is pure: draw(ctx, state) paints one frame from the analysis and the
// automaton snapshot, and holds no state of its own except the shutter flash
// timer, which has to outlive the frame that triggered it.

import { BORDER } from "./constants.js";
import { arrowFor } from "./guidance.js";

// The guide rectangle is a fraction of the shorter frame dimension, matching the
// framing the quality gates expect (pack fills 20–92% of the frame).
const GUIDE_INSET = 0.08;
const CORNER = 28;
const SHUTTER_MS = 220;

export function createOverlay(canvas) {
  const ctx = canvas.getContext("2d");
  let shutterAt = 0;

  function flash() {
    shutterAt = performance.now();
  }

  function draw(analysis, machine, scale) {
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const border = analysis.border || BORDER.RED;
    drawGuideFrame(ctx, width, height, border);

    if (analysis.box && analysis.box.length === 4) {
      drawDetectionBox(ctx, analysis, scale, border);
    }

    drawCenterCross(ctx, width, height, border);

    const arrow = arrowFor(analysis.guide);
    if (arrow) drawArrow(ctx, width, height, arrow, border);

    if (machine && machine.progress > 0) {
      drawProgressRing(ctx, width, height, machine.progress, border);
      if (machine.countdown > 0 && machine.progress > 0.15) {
        drawCountdown(ctx, width, height, machine.countdown);
      }
    }

    drawReadout(ctx, width, height, analysis);
    drawShutter(ctx, width, height);
  }

  function drawShutter(ctx2, width, height) {
    if (!shutterAt) return;
    const elapsed = performance.now() - shutterAt;
    if (elapsed > SHUTTER_MS) {
      shutterAt = 0;
      return;
    }
    // A quick white flash that eases out — the feedback that a photo was taken.
    const alpha = 0.85 * (1 - elapsed / SHUTTER_MS);
    ctx2.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx2.fillRect(0, 0, width, height);
  }

  return { draw, flash };
}

function drawGuideFrame(ctx, width, height, colour) {
  const inset = Math.min(width, height) * GUIDE_INSET;
  const x = inset;
  const y = inset;
  const w = width - inset * 2;
  const h = height - inset * 2;

  // Dim everything outside the guide so the eye goes to the pack.
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(x, y, w, h);
  ctx.fill("evenodd");

  // Corner brackets rather than a full rectangle: a closed box invites the user
  // to match the pack to the box exactly, which is not what the gates check.
  ctx.strokeStyle = colour;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  const corners = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x + w, y + h, -1, -1],
    [x, y + h, 1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx + CORNER * sx, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + CORNER * sy);
    ctx.stroke();
  }
}

function drawDetectionBox(ctx, analysis, scale, colour) {
  const [bx, by, bw, bh] = analysis.box.map((v) => v * scale);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.setLineDash([]);

  // Confidence chip in the box's top-left.
  const label = `${Math.round(analysis.confidence * 100)}%`;
  ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
  const pad = 6;
  const textW = ctx.measureText(label).width;
  ctx.fillStyle = colour;
  ctx.fillRect(bx, Math.max(0, by - 22), textW + pad * 2, 20);
  ctx.fillStyle = "#0b1020";
  ctx.fillText(label, bx + pad, Math.max(14, by - 7));
}

function drawCenterCross(ctx, width, height, colour) {
  const cx = width / 2;
  const cy = height / 2;
  ctx.strokeStyle = colour;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx, cy + 12);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawArrow(ctx, width, height, direction, colour) {
  const cx = width / 2;
  const cy = height / 2;
  // Pulse so the arrow reads as an instruction, not a static decoration.
  const pulse = 1 + 0.12 * Math.sin(performance.now() / 160);
  const size = 34 * pulse;
  const offset = Math.min(width, height) * 0.22;

  const spots = {
    left: [cx - offset, cy, -1, 0],
    right: [cx + offset, cy, 1, 0],
    up: [cx, cy - offset, 0, -1],
    down: [cx, cy + offset, 0, 1],
    in: [cx, cy, 0, 0],
    out: [cx, cy, 0, 0],
  };
  const [ax, ay, dx, dy] = spots[direction] || spots.in;

  ctx.fillStyle = colour;
  if (direction === "in" || direction === "out") {
    // Concentric chevrons meaning "closer" / "further".
    ctx.strokeStyle = colour;
    ctx.lineWidth = 3;
    const r = direction === "in" ? 40 * pulse : 64 * pulse;
    ctx.beginPath();
    ctx.arc(ax, ay, r, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(ax + dx * size, ay + dy * size);
  ctx.lineTo(ax - dy * size * 0.6 - dx * size * 0.4, ay - dx * size * 0.6 - dy * size * 0.4);
  ctx.lineTo(ax + dy * size * 0.6 - dx * size * 0.4, ay + dx * size * 0.6 - dy * size * 0.4);
  ctx.closePath();
  ctx.fill();
}

function drawProgressRing(ctx, width, height, progress, colour) {
  const cx = width / 2;
  const cy = height - 92;
  const radius = 30;
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = colour;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
}

function drawCountdown(ctx, width, height, seconds) {
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 22px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(seconds), width / 2, height - 92);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function drawReadout(ctx, width, height, analysis) {
  const distance =
    analysis.distance_cm == null ? "—" : `~${analysis.distance_cm} cm`;
  const text = `${analysis.label || ""}`;

  // Instruction line, centered near the bottom.
  ctx.font = "600 17px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  const metrics = ctx.measureText(text);
  const boxW = metrics.width + 28;
  const boxX = width / 2 - boxW / 2;
  const boxY = height - 52;
  ctx.fillStyle = "rgba(11,16,32,0.78)";
  roundRect(ctx, boxX, boxY, boxW, 32, 16);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, width / 2, boxY + 21);
  ctx.textAlign = "start";

  // Distance chip, top-right.
  ctx.font = "500 12px ui-monospace, SFMono-Regular, monospace";
  ctx.fillStyle = "rgba(11,16,32,0.7)";
  roundRect(ctx, width - 104, 14, 90, 24, 12);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillText(distance, width - 94, 30);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
