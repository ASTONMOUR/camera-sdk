"use client";

import { SLOT_LABEL, type CapturedSlot, type Slot } from "@/lib/core";

/**
 * The strip of what has been taken so far. Tapping one drops it and rewinds the
 * flow to that slot — a retake, not a shutter, which is why this exists in a
 * camera the spec says has no shutter button.
 */
export function CaptureTray({
  stepLabel,
  captured,
  onRetake,
  onFlip,
  onCapture,
}: {
  stepLabel: string;
  captured: CapturedSlot[];
  onRetake: (slot: Slot) => void;
  onFlip: () => void;
  onCapture: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3.5 border-t border-line bg-panel px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <span className="font-semibold">{stepLabel}</span>

      <div className="flex flex-1 gap-2 overflow-x-auto">
        {captured.map((item) => (
          <button
            key={item.slot}
            onClick={() => onRetake(item.slot)}
            title={`${SLOT_LABEL[item.slot] ?? item.slot} — tap to retake`}
            className="shrink-0 rounded-lg border border-line transition hover:border-close"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.preview}
              alt={SLOT_LABEL[item.slot] ?? item.slot}
              className="h-11 w-11 rounded-lg object-cover"
            />
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <GhostButton onClick={onFlip}>Flip camera</GhostButton>
        <GhostButton onClick={onCapture}>Capture now</GhostButton>
      </div>
    </div>
  );
}

function GhostButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-[10px] border border-line px-4 py-2.5 text-sm font-semibold text-muted transition hover:border-muted hover:text-ink"
    >
      {children}
    </button>
  );
}
