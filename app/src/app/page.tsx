"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { API_BASE, SURFACE_SEQUENCES, type PackShape } from "@/lib/core";

const SHAPES: Array<{
  id: PackShape;
  label: string;
  examples: string;
  art: React.ReactNode;
}> = [
  {
    id: "flat",
    label: "Flat",
    examples: "Pouch, carton, wrapper, sachet",
    art: (
      <>
        <rect x="26" y="12" width="68" height="66" rx="5" />
        <path d="M26 26h68" />
      </>
    ),
  },
  {
    id: "cylindrical",
    label: "Cylindrical",
    examples: "Bottle, can, jar, tin",
    art: (
      <>
        <ellipse cx="60" cy="20" rx="26" ry="9" />
        <path d="M34 20v50" />
        <path d="M86 20v50" />
        <ellipse cx="60" cy="70" rx="26" ry="9" />
      </>
    ),
  },
];

export default function ShapePicker() {
  const [health, setHealth] = useState<string>("checking…");
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((r) => r.json())
      .then((h) => {
        setHealth(`OCR: ${h.ocr_backend} · ${h.compliance_rules} rules`);
        setOffline(h.ocr_backend === "offline");
      })
      .catch(() => {
        setHealth("server unreachable");
        setOffline(true);
      });
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="h-2 w-2 rounded-full bg-ready" />
          Product Capture
        </div>
        <span
          className={`rounded-full border border-line bg-panel px-3 py-1.5 font-mono text-xs ${
            offline ? "text-close" : "text-muted"
          }`}
        >
          {health}
        </span>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">
          What shape is the package?
        </h1>
        <p className="mb-7 mt-1.5 text-muted">
          The shape decides how many photographs are needed and what you will be
          asked to do between them.
        </p>

        <div className="grid gap-3.5 sm:grid-cols-2">
          {SHAPES.map((shape) => (
            <Link
              key={shape.id}
              href={`/capture?shape=${shape.id}`}
              className="group rounded-2xl border border-line bg-panel p-6 transition hover:-translate-y-0.5 hover:border-accent"
            >
              <svg
                viewBox="0 0 120 90"
                aria-hidden
                className="mb-3.5 h-[72px] w-24 fill-none stroke-accent stroke-[2.5] [stroke-linecap:round] [stroke-linejoin:round]"
              >
                {shape.art}
              </svg>
              <h2 className="text-lg font-semibold">{shape.label}</h2>
              <p className="mb-2.5 text-sm text-muted">{shape.examples}</p>
              <span className="text-xs text-accent">
                {SURFACE_SEQUENCES[shape.id].length} photographs
              </span>
            </Link>
          ))}
        </div>

        <p className="mt-7 text-sm text-muted">
          The camera captures on its own. Hold the pack inside the guide and stay
          still for a second — there is no shutter button.
        </p>
      </main>
    </div>
  );
}
