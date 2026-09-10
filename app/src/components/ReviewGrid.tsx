"use client";

import { SLOT_LABEL, type CapturedSlot, type Slot } from "@/lib/core";

/**
 * The gate between capture and compliance.
 *
 * Compliance is derived entirely from these photographs, so a human confirms
 * them before it runs. A blurred back-of-pack produces a confident FAIL that is
 * really an OCR miss, and that is a much more expensive mistake to unpick than
 * one more press of Retake.
 */
export function ReviewGrid({
  captured,
  submitting,
  onRetake,
  onSubmit,
}: {
  captured: CapturedSlot[];
  submitting: boolean;
  onRetake: (slot: Slot) => void;
  onSubmit: () => void;
}) {
  return (
    <section className="mx-auto w-full max-w-5xl flex-1 px-5 py-7">
      <h1 className="text-2xl font-semibold tracking-tight">
        Check your photographs
      </h1>
      <p className="mb-5 mt-1.5 text-muted">
        {captured.length} photographs. Check each one is sharp and shows the
        whole pack before submitting — the report is only as good as these.
      </p>

      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
        {captured.map((item) => (
          <figure
            key={item.slot}
            className="rounded-2xl border border-line bg-panel p-2.5 text-center"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.preview}
              alt={SLOT_LABEL[item.slot] ?? item.slot}
              className="block aspect-[3/4] w-full rounded-[10px] bg-black object-contain"
            />
            <figcaption className="my-2 text-[13px] font-semibold">
              {SLOT_LABEL[item.slot] ?? item.slot}
            </figcaption>
            <button
              onClick={() => onRetake(item.slot)}
              disabled={submitting}
              className="rounded-[10px] border border-line px-4 py-2 text-sm font-semibold text-muted transition hover:border-muted hover:text-ink disabled:opacity-50"
            >
              Retake
            </button>
          </figure>
        ))}
      </div>

      <button
        onClick={onSubmit}
        disabled={submitting}
        className="mt-5 rounded-[10px] bg-accent px-6 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
      >
        {submitting ? "Reading the label…" : "Submit for compliance"}
      </button>
    </section>
  );
}
