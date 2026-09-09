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
  between: string | null;
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
    between: null,
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
          setState((prev) => ({ ...prev, captured: [...prev.captured, item] })),
        between: (text) => patch({ between: text }),
        stats: (s) => patch({ stats: s }),
        error: (err) => patch({ error: String(err?.message ?? err) }),
        complete: async () => {
          patch({ between: "Reading the label and checking it against the rules…" });
          try {
            const report = await pipeline.compliance();
            if (!cancelled) patch({ report, between: null });
          } catch (err) {
            if (!cancelled) patch({ error: String((err as Error)?.message ?? err) });
          }
        },
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

  const retake = useCallback((slot: Slot) => {
    pipelineRef.current?.retake(slot);
    setState((prev) => ({ ...prev, captured: prev.captured.filter((c) => c.slot !== slot) }));
  }, []);

  return { videoRef, canvasRef, state, dismissBetween, flip, forceCapture, retake };
}
