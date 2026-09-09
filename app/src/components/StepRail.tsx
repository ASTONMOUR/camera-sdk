"use client";

import { SLOT_LABEL, type Slot } from "@/lib/core";

/**
 * Progress rail over the viewport: one bar per slot, filled as they are taken.
 * It answers "how much longer is this" without a number, which is what people
 * actually want to know mid-capture.
 */
export function StepRail({ steps, activeIndex }: { steps: Slot[]; activeIndex: number }) {
  return (
    <div className="absolute left-1/2 top-3.5 z-10 flex -translate-x-1/2 gap-1.5">
      {steps.map((slot, i) => (
        <span
          key={`${slot}-${i}`}
          title={SLOT_LABEL[slot] ?? slot}
          className={`h-1 w-6 rounded-full transition-colors ${
            i < activeIndex
              ? "bg-ready"
              : i === activeIndex
                ? "bg-close"
                : "bg-white/25"
          }`}
        />
      ))}
    </div>
  );
}
