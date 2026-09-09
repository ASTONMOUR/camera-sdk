"use client";

import type { ComplianceReport, VerdictState } from "@/lib/core";

const TONE: Record<string, string> = {
  pass: "bg-ready/15 text-ready",
  fail: "bg-invalid/15 text-invalid",
  review: "bg-close/15 text-close",
  incomplete: "bg-close/15 text-close",
  unreadable: "bg-line text-muted",
  cannot_compute: "bg-line text-muted",
};

const tone = (state: string) => TONE[state.toLowerCase()] ?? "bg-line text-muted";

/**
 * The report. Six verdict states, not two — "I could not read this" and "this
 * is non-compliant" are different answers and showing them as one would be a
 * lie about what the system knows.
 */
export function ReportView({ report, onRestart }: { report: ComplianceReport; onRestart: () => void }) {
  const counts = (Object.entries(report.summary) as Array<[VerdictState, number]>)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${n} ${state.toLowerCase()}`)
    .join(" · ");

  return (
    <section className="mx-auto w-full max-w-5xl flex-1 px-5 py-7">
      <div className="mb-5">
        <span
          className={`inline-block rounded-full px-3 py-1.5 font-mono text-xs font-bold tracking-widest ${tone(
            report.worst,
          )}`}
        >
          {report.worst}
        </span>
        <h1 className="mb-1 mt-2.5 text-2xl font-semibold tracking-tight">
          Compliance report
        </h1>
        <p className="text-sm text-muted">
          {report.surfaces_captured.length} surfaces · OCR {report.ocr_backend} · {counts}
        </p>
        {report.ocr_backend === "offline" && (
          <p className="mt-2 rounded-lg border border-line border-l-2 border-l-close bg-panel px-3 py-2 text-sm text-muted">
            The OCR backend is offline, so no text was read from the images. The
            rules ran, but every field below is empty for that reason — not
            because the pack omits them.
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Declared fields">
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(report.fields).map(([name, field]) => (
                <tr key={name} className="border-b border-line last:border-0">
                  <td className="w-2/5 py-2 pr-2 capitalize text-muted">
                    {name.replace(/_/g, " ")}
                  </td>
                  <td className={`py-2 ${field.value ? "" : "italic text-invalid"}`}>
                    {field.value ?? "— not found —"}
                  </td>
                  <td className="w-[15%] py-2 text-right font-mono text-xs text-muted">
                    {field.value ? `${Math.round(field.confidence * 100)}%` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Rule verdicts">
          {report.verdicts.map((verdict, i) => {
            const state = String(verdict.state ?? "");
            return (
              <div
                key={`${verdict.rule_id ?? i}`}
                className="grid grid-cols-[92px_1fr] gap-x-2.5 gap-y-1 border-b border-line py-2 text-[13px] last:border-0"
              >
                <span
                  className={`font-mono text-[10px] font-bold leading-6 tracking-wider ${
                    tone(state).split(" ")[1]
                  }`}
                >
                  {state}
                </span>
                <span className="font-mono text-xs text-muted">
                  {String(verdict.rule_id ?? verdict.rule ?? "")}
                </span>
                <span className="col-start-2">
                  {String(verdict.reason ?? verdict.message ?? "")}
                </span>
              </div>
            );
          })}
        </Panel>
      </div>

      <button
        onClick={onRestart}
        className="mt-5 rounded-[10px] border border-line px-4 py-2.5 text-sm font-semibold text-muted transition hover:border-muted hover:text-ink"
      >
        Start over
      </button>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4.5">
      <h3 className="mb-3 text-sm font-semibold text-muted">{title}</h3>
      {children}
    </div>
  );
}
