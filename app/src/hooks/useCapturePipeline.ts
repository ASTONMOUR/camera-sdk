"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  API_BASE,
  createPipeline,
  type Analysis,
  type CapturedSlot,
  type ComplianceReport,
  type PackShape,
  type Pipeline,
  type Plan,
  type Slot,
  type Stats,
} from "@/lib/core";

export interface CaptureState {
  ready: boolean;
  plan: Plan | null;
  step: Slot | null;
  analysis: Analysis | null;
  stats: Stats | null;
  captured: CapturedSlot[];
  lastShot: CapturedSlot | null;
  between: string | null;
  complete: boolean;
  submitting: boolean;
  report: ComplianceReport | null;
  error: string | null;
  backend: string | null;
}

/**
 * Drives one capture session.
 *
 * The pipeline is imperative and frame-driven; React is not. So the pipeline
 * owns the loop and this hook only mirrors the parts the UI actually renders.
 * The per-frame analysis deliberately does NOT drive a re-render — at 25fps
 * that would re-render the whole tree 25 times a second for a number that the
 * canvas is already drawing. Only the transitions that change layout do.
 */
export function useCapturePipeline(shape: PackShape) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipelineRef = useRef<Pipeline | null>(null);

  const [state, setState] = useState<CaptureState>({
    ready: false,
    plan: null,
    step: null,
    analysis: null,
    stats: null,
    captured: [],
    lastShot: null,
    between: null,
    complete: false,
    submitting: false,
    report: null,
    error: null,
    backend: null,
  });

  const patch = useCallback((next: Partial<CaptureState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let cancelled = false;

    const pipeline = createPipeline({
      video,
      canvas,
      shape,
      apiBase: API_BASE,
      handlers: {
        session: (res) => patch({ plan: res.plan, backend: res.ocr_backend, ready: true }),
        step: (slot) => patch({ step: slot }),
        captured: (item) =>
          // Replace on retake, matching the pipeline's own list — appending
          // would leave the stale photo in the review grid.
          setState((prev) => {
            const at = prev.captured.findIndex((c) => c.slot === item.slot);
            const captured = at >= 0
              ? prev.captured.map((c, i) => (i === at ? item : c))
              : [...prev.captured, item];
            return { ...prev, captured, lastShot: item };
          }),
        between: (text) => patch({ between: text }),
        stats: (s) => patch({ stats: s }),
        error: (err) => patch({ error: String(err?.message ?? err) }),
        // Not `await pipeline.compliance()`. The photographs are what the
        // report is derived from, so a human confirms them first.
        complete: () => patch({ complete: true, between: null }),
      },
    });

    pipelineRef.current = pipeline;
    pipeline.start().catch((err: Error) => {
      if (!cancelled) {
        patch({
          error:
            `${err.message} — the camera needs a secure context; ` +
            `use localhost or HTTPS.`,
        });
      }
    });

    return () => {
      cancelled = true;
      void pipeline.stop();
      pipelineRef.current = null;
    };
  }, [shape, patch]);

  const dismissBetween = useCallback(() => patch({ between: null }), [patch]);
  const flip = useCallback(() => void pipelineRef.current?.flip(), []);
  const forceCapture = useCallback(() => void pipelineRef.current?.forceCapture(), []);

  // Drop one photograph and go back to the camera for that slot. Clears
  // `complete` so the review screen yields to the viewport; the pipeline picks
  // the retaken slot back up as the next missing one and resumes analysis.
  const retake = useCallback((slot: Slot) => {
    // Refused mid-upload — leave the mirrored state alone or it drifts from the
    // pipeline's own list.
    if (!pipelineRef.current?.retake(slot)) return;
    setState((prev) => ({
      ...prev,
      captured: prev.captured.filter((c) => c.slot !== slot),
      complete: false,
      between: null,
    }));
  }, []);

  const submit = useCallback(async () => {
    const pipeline = pipelineRef.current;
    if (!pipeline) return;
    setState((prev) => ({ ...prev, submitting: true, error: null }));
    try {
      const report = await pipeline.compliance();
      // The session is over once the report exists. Nothing stops the camera
      // otherwise — the page stays mounted, so the effect cleanup never runs
      // and the stream would stay live behind the report.
      await pipeline.stop();
      setState((prev) => ({ ...prev, report, submitting: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        submitting: false,
        error: String((err as Error)?.message ?? err),
      }));
    }
  }, []);

  return {
    videoRef,
    canvasRef,
    state,
    dismissBetween,
    flip,
    forceCapture,
    retake,
    submit,
  };
}
