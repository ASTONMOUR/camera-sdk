"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { CaptureTray } from "@/components/CaptureTray";
import { ReportView } from "@/components/ReportView";
import { ReviewGrid } from "@/components/ReviewGrid";
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

  const { videoRef, canvasRef, state, dismissBetween, flip, forceCapture, retake, submit } =
    useCapturePipeline(shape);

  const activeIndex = state.plan && state.step ? state.plan.steps.indexOf(state.step) : 0;

  // The review and report are rendered *over* the stage, never instead of it.
  // Returning a different tree would unmount <video>, and the pipeline holds a
  // reference to that element — a retake would then remount a fresh, empty one
  // and the viewport would be black with the stream still attached to a node
  // that is no longer in the document.
  const covered = state.complete || state.report !== null;

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        stats={
          !covered && state.stats
            ? `${state.stats.fps} fps · ${state.stats.latency_p50}ms · step ${state.stats.step}/${state.stats.total}`
            : undefined
        }
      />

      <main className={`flex-1 flex-col ${covered ? "hidden" : "flex"}`}>
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

      {state.report ? (
        <ReportView report={state.report} onRestart={() => (window.location.href = "/")} />
      ) : (
        state.complete && (
          <ReviewGrid
            captured={state.captured}
            submitting={state.submitting}
            onRetake={retake}
            onSubmit={submit}
          />
        )
      )}

      {state.between && (
        <Sheet
          title={
            state.lastShot
              ? `${SLOT_LABEL[state.lastShot.slot] ?? state.lastShot.slot} captured`
              : "Captured"
          }
          body={state.between}
          preview={state.lastShot?.preview}
          onRetake={state.lastShot ? () => retake(state.lastShot!.slot) : undefined}
          onContinue={dismissBetween}
        />
      )}

      {state.error && <Toast>{state.error}</Toast>}
    </div>
  );
}

function Toast({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed bottom-24 left-1/2 z-20 max-w-[min(92vw,460px)] -translate-x-1/2 rounded-[10px] border border-line border-l-[3px] border-l-close bg-panel px-4 py-3 text-sm shadow-2xl">
      {children}
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
  preview,
  onRetake,
  onContinue,
}: {
  title: string;
  body: string;
  preview?: string;
  onRetake?: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-[#060914cc] p-5 backdrop-blur">
      <div className="max-w-sm rounded-[18px] border border-line bg-panel p-8 text-center">
        {preview ? (
          // Big enough to actually judge. A thumbnail hides the blur and the
          // clipped corner that make the OCR fail two screens later.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="The photograph just taken"
            className="mb-4 block max-h-[46vh] w-full rounded-xl border border-line bg-black object-contain"
          />
        ) : (
          <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-full bg-ready/15 text-xl text-ready">
            ✓
          </div>
        )}
        <h2 className="mb-2 text-lg font-semibold">{title}</h2>
        <p className="mb-5 text-muted">{body}</p>
        <div className="flex flex-wrap justify-center gap-2.5">
          {onRetake && (
            <button
              onClick={onRetake}
              className="rounded-[10px] border border-line px-4 py-3 text-sm font-semibold text-muted transition hover:border-muted hover:text-ink"
            >
              Retake this one
            </button>
          )}
          <button
            onClick={onContinue}
            className="rounded-[10px] bg-accent px-6 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500"
          >
            Looks good
          </button>
        </div>
      </div>
    </div>
  );
}
