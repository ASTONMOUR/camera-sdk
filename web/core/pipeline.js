// The capture pipeline: one object that runs the whole guided session.
//
// Loop, once per animation frame:
//   camera.grab() -> worker (transferred) -> analysis -> automaton -> overlay
//
// Only one frame is ever in flight in the worker. Queuing frames would build an
// unbounded backlog on a slow device and the guidance would lag behind what the
// user is actually doing, which is worse than analysing fewer frames.

import { createCamera } from "./camera.js";
import { createAutomaton, STATE } from "./automaton.js";
import { createOverlay } from "./overlay.js";
import { buildPlan, nextMissingSlotIndex } from "./plan.js";
import { SERVER } from "./constants.js";

const WORK_WIDTH = 320; // must match detect.js — box coords come back in this space

export function createPipeline({ video, canvas, shape, apiBase = SERVER.origin, handlers = {} }) {
  const camera = createCamera(video);
  const overlay = createOverlay(canvas);
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const plan = buildPlan(shape);

  let sessionId = null;
  let stepIndex = 0;
  let running = false;
  let busy = false;          // a frame is in the worker
  let uploading = false;     // a still is being sent
  let seq = 0;
  let lastAnalysis = { quality: { reasons: [] }, box: [], confidence: 0, label: "Starting camera…" };
  const captured = [];
  const fps = { frames: 0, since: 0, value: 0 };
  const latency = [];

  const automaton = createAutomaton({ onCapture: () => { void takeStill(); } });

  worker.onmessage = (event) => {
    if (event.data.type !== "analysis") return;
    busy = false;
    lastAnalysis = event.data;
    latency.push(event.data.latency_ms);
    if (latency.length > 60) latency.shift();
    // The automaton only advances on analysed frames, so the one-second hold is
    // one second of *analysis*, not of wall clock on a device that can't keep up.
    if (!uploading) automaton.push(event.data);
    emit("analysis", event.data);
  };

  function emit(name, payload) {
    const fn = handlers[name];
    if (typeof fn === "function") fn(payload);
  }

  async function start() {
    emit("status", "Requesting camera…");
    const info = await camera.start();
    sizeCanvas();
    window.addEventListener("resize", sizeCanvas);

    emit("status", "Starting session…");
    const res = await api("POST", "/api/session", { shape });
    sessionId = res.session_id;
    emit("session", { ...res, plan });

    running = true;
    fps.since = performance.now();
    requestAnimationFrame(tick);
    emit("step", currentStep());
    return info;
  }

  function sizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    // A hidden stage measures 0x0. Sizing to that would blank the overlay and
    // leave it blank, because un-hiding fires no resize event to correct it.
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }

  function tick() {
    if (!running) return;

    if (!busy) {
      const frame = camera.grab();
      if (frame) {
        busy = true;
        seq += 1;
        // Copy so the buffer can be transferred without detaching the canvas's
        // own ImageData, which the next grab() reuses.
        const copy = frame.rgba.slice().buffer;
        worker.postMessage(
          { type: "frame", rgba: copy, width: frame.width, height: frame.height, seq },
          [copy]
        );
      }
    }

    // Working-pixel -> canvas-pixel scale. The box is always in a WORK_WIDTH-wide
    // space, so this is the only conversion the overlay needs.
    overlay.draw(lastAnalysis, automaton.snapshot(), canvas.width / WORK_WIDTH);

    fps.frames += 1;
    const elapsed = performance.now() - fps.since;
    if (elapsed >= 1000) {
      fps.value = Math.round((fps.frames * 1000) / elapsed);
      fps.frames = 0;
      fps.since = performance.now();
      emit("stats", stats());
    }

    requestAnimationFrame(tick);
  }

  // Fired by the automaton once the pack has held ready for a full second.
  async function takeStill() {
    if (uploading || !sessionId) return;
    uploading = true;
    const slot = currentStep();
    overlay.flash();
    emit("status", `Capturing ${slot}…`);

    try {
      const dataUrl = await camera.still();
      const body = {
        session_id: sessionId,
        slot,
        image_b64: dataUrl.split(",")[1],
        quality: lastAnalysis.quality,
      };
      const stored = await api("POST", "/api/capture", body);

      // Replace, don't append: a retake re-shoots a slot that is already in the
      // list, and two entries for one slot would show the stale photo in the
      // review grid and double-count the progress rail.
      const item = { slot, ...stored, preview: dataUrl };
      const at = captured.findIndex((c) => c.slot === slot);
      if (at >= 0) captured[at] = item;
      else captured.push(item);
      emit("captured", item);

      // Motion is measured against the previous frame; after a deliberate move to
      // the next surface that reference is meaningless, so clear it.
      worker.postMessage({ type: "reset" });

      // The cursor is derived from what has actually been captured, not bumped
      // by one. Retake sets it backwards, and a linear ++ would then march
      // forward re-shooting slots that are already done.
      const next = nextMissingIndex();
      const done = next < 0;
      if (!done) stepIndex = next;

      automaton.finish({ done });
      if (done) {
        // Stop analysing while the review screen is up. retake() resumes.
        pause();
        emit("complete", captured.slice());
      } else {
        emit("step", currentStep());
        // between[i - 1] is the instruction for arriving at steps[i], which
        // stays correct when the cursor jumps rather than increments.
        emit("between", plan.between[stepIndex - 1] || "");
      }
    } catch (err) {
      // A failed upload must not strand the machine in CAPTURING forever.
      automaton.finish({ done: false });
      emit("error", err);
    } finally {
      uploading = false;
    }
  }

  async function compliance() {
    if (!sessionId) throw new Error("no session");
    emit("status", "Reading the label…");
    const report = await api("POST", "/api/compliance", { session_id: sessionId });
    emit("compliance", report);
    return report;
  }

  // Bound to this pipeline's apiBase. In the zero-build UI that is the empty
  // string (same origin as the page); under Next dev or Capacitor the app is
  // not served by FastAPI, so it has to be pointed at the API explicitly.
  async function api(method, path, body) {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`${method} ${path} failed (${res.status}): ${detail}`);
    }
    return res.json();
  }

  function currentStep() {
    return plan.steps[Math.min(stepIndex, plan.steps.length - 1)];
  }

  // Index of the first slot with no photo, or -1 when every slot is captured.
  function nextMissingIndex() {
    return nextMissingSlotIndex(plan.steps, captured);
  }

  function stats() {
    const sorted = [...latency].sort((a, b) => a - b);
    return {
      fps: fps.value,
      latency_p50: sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0,
      latency_p95: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0,
      // Live rectangularity, so PACKET_ALIGNMENT_MIN can be calibrated by
      // pointing a real camera at a real pack and reading the number, rather
      // than by guessing and waiting for a false capture to prove it wrong.
      alignment: lastAnalysis.alignment ?? 0,
      step: stepIndex + 1,
      total: plan.steps.length,
    };
  }

  // Manual override. The spec says no shutter button in the normal flow; this
  // exists for the retake affordance, which is a different thing from a shutter.
  async function forceCapture() {
    await takeStill();
  }

  function retake(slot) {
    // Mid-upload the captured list is about to be written by takeStill; letting
    // a retake interleave would drop the entry that upload is still adding.
    if (uploading) return false;
    const index = plan.steps.indexOf(slot);
    if (index < 0) return false;
    stepIndex = index;
    const at = captured.findIndex((c) => c.slot === slot);
    if (at >= 0) captured.splice(at, 1);
    automaton.reset();
    resume();
    worker.postMessage({ type: "reset" });
    emit("step", currentStep());
    return true;
  }

  async function stop() {
    running = false;
    window.removeEventListener("resize", sizeCanvas);
    worker.terminate();
    await camera.stop();
  }

  // Halt analysis without touching the stream. The review screen can sit open
  // for a while, and detecting at 25fps behind it is pure battery drain — but
  // dropping the stream would re-prompt for camera permission on resume.
  function pause() {
    running = false;
  }

  function resume() {
    if (running) return;
    running = true;
    busy = false;
    worker.postMessage({ type: "reset" });
    requestAnimationFrame(tick);
  }

  return {
    start,
    stop,
    pause,
    resume,
    compliance,
    forceCapture,
    retake,
    flip: () => camera.flip(),
    stats,
    plan,
    get sessionId() { return sessionId; },
    get captured() { return captured; },
    get state() { return automaton.snapshot().state; },
    STATE,
  };
}
