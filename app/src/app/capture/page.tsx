"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { CaptureTray } from "@/components/CaptureTray";
import { ReportView } from "@/components/ReportView";
import { StepRail } from "@/components/StepRail";
import { useCapturePipeline } from "@/hooks/useCapturePipeline";
import { SLOT_LABEL, type PackShape } from "@/lib/core";

export default function CapturePage() {
  // useSearchParams needs a Suspense boundary under static export.
  return (
    <Suspense fallback={<div className="grid min-h-dvh place-items-center text-muted">Loading…</div>}>
      <CaptureScreen />
    </Suspense>
  );
}

function CaptureScreen() {
  const params = useSearchParams();
  const shape: PackShape = params.get("shape") === "cylindrical" ? "cylindrical" : "flat";

  const { videoRef, canvasRef, state, dismissBetween, flip, forceCapture, retake } =
    useCapturePipeline(shape);

  const activeIndex = state.plan && state.step ? state.plan.steps.indexOf(state.step) : 0;

  if (state.report) {
    return (
      <div className="flex min-h-dvh flex-col">
        <TopBar />
        <ReportView report={state.report} onRestart={() => (window.location.href = "/")} />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        stats={
          state.stats
            ? `${state.stats.fps} fps · ${state.stats.latency_p50}ms · step ${state.stats.step}/${state.stats.total}`
            : undefined
        }
      />

      <main className="flex flex-1 flex-col">
        <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="video-layer object-cover"
          />
          <canvas ref={canvasRef} className="video-layer pointer-events-none" />
          {state.plan && <StepRail steps={state.plan.steps} activeIndex={activeIndex} />}
        </div>

        <CaptureTray
          stepLabel={state.step ? (SLOT_LABEL[state.step] ?? state.step) : "Starting camera…"}
          captured={state.captured}
          onRetake={retake}
          onFlip={flip}
          onCapture={forceCapture}
        />
      </main>

      {state.between && (
        <Sheet
          title={state.report ? "Done" : "Captured"}
          body={state.between}
          onContinue={dismissBetween}
        />
      )}

      {state.error && (
        <div className="fixed bottom-24 left-1/2 z-20 max-w-[min(92vw,460px)] -translate-x-1/2 rounded-[10px] border border-line border-l-[3px] border-l-close bg-panel px-4 py-3 text-sm shadow-2xl">
          {state.error}
        </div>
      )}
    </div>
  );
}

function TopBar({ stats }: { stats?: string }) {
  return (
    <header className="flex items-center justify-between border-b border-line px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
        <span className="h-2 w-2 rounded-full bg-ready" />
        Product Capture
      </Link>
      <span className="rounded-full border border-line bg-panel px-3 py-1.5 font-mono text-xs text-muted">
        {stats ?? "—"}
      </span>
    </header>
  );
}

function Sheet({
  title,
  body,
  onContinue,
}: {
  title: string;
  body: string;
  onContinue: () => void;
}) {
  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-[#060914cc] p-5 backdrop-blur">
      <div className="max-w-sm rounded-[18px] border border-line bg-panel p-8 text-center">
        <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-full bg-ready/15 text-xl text-ready">
          ✓
        </div>
        <h2 className="mb-2 text-lg font-semibold">{title}</h2>
        <p className="mb-5 text-muted">{body}</p>
        <button
          onClick={onContinue}
          className="rounded-[10px] bg-accent px-6 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
