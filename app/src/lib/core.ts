// Typed surface over the shared browser core.
//
// The core in ../../web/core is plain ES modules on purpose: it has to run in a
// browser with no build step. That does not mean the app should consume it
// untyped, so the shapes are declared once, here, and everything in the React
// tree imports from this file rather than reaching into the core directly.

// @ts-expect-error — plain JS module, typed by the declarations below.
import { createPipeline as createPipelineJs } from "@core/pipeline.js";
// @ts-expect-error — plain JS module.
import { SURFACE_SEQUENCES, SLOT_LABEL, GUIDE, BORDER, STABLE_FRAMES } from "@core/constants.js";
// @ts-expect-error — plain JS module.
import { buildPlan as buildPlanJs } from "@core/plan.js";

export type PackShape = "flat" | "cylindrical";

export type Slot = "front" | "back" | "side_1" | "side_2" | "top" | "base";

export type GuideCode = string;

export interface Quality {
  blur: number;
  brightness: number;
  exposure_good: boolean;
  glare: number;
  reflection: boolean;
  motion: number;
  sharpness: number;
  packet_present: boolean;
  packet_centered: boolean;
  packet_size_ok: boolean;
  perspective_ok: boolean;
  multiple_packets: boolean;
  duplicate: boolean;
  ready: boolean;
  reasons: GuideCode[];
}

export interface Analysis {
  box: number[];
  center: number[];
  confidence: number;
  angle: number;
  area: number;
  aspect_ratio: number;
  distance_cm: number | null;
  quality: Quality;
  guide: GuideCode;
  label: string;
  border: string;
  latency_ms: number;
}

export interface Plan {
  shape: PackShape;
  steps: Slot[];
  total_steps: number;
  between: string[];
}

export interface Stats {
  fps: number;
  latency_p50: number;
  latency_p95: number;
  step: number;
  total: number;
}

export interface CapturedSlot {
  slot: Slot;
  surface: string;
  stored: boolean;
  path: string;
  preview: string;
  image_quality: Record<string, number | boolean>;
}

export interface MetadataField {
  value: string | null;
  confidence: number;
  as_printed: string | null;
}

export type VerdictState =
  | "PASS" | "FAIL" | "REVIEW" | "INCOMPLETE" | "UNREADABLE" | "CANNOT_COMPUTE";

export interface ComplianceReport {
  session_id: string;
  shape: PackShape | null;
  surfaces_captured: string[];
  worst: VerdictState;
  summary: Record<VerdictState, number>;
  fields: Record<string, MetadataField>;
  nutrition: Record<string, number | string | null>;
  ingredients_raw: string | null;
  verdicts: Array<Record<string, unknown>>;
  advisories: Array<Record<string, unknown>>;
  ocr_backend: "paddleocr" | "gemini" | "offline";
  image_quality: Record<string, number | boolean>;
}

export interface PipelineHandlers {
  session?: (res: { session_id: string; ocr_backend: string; plan: Plan }) => void;
  step?: (slot: Slot) => void;
  captured?: (item: CapturedSlot) => void;
  between?: (text: string) => void;
  complete?: (items: CapturedSlot[]) => void;
  analysis?: (a: Analysis) => void;
  stats?: (s: Stats) => void;
  status?: (msg: string) => void;
  compliance?: (report: ComplianceReport) => void;
  error?: (err: Error) => void;
}

export interface Pipeline {
  start(): Promise<{ width: number; height: number; facingMode: string }>;
  stop(): Promise<void>;
  compliance(): Promise<ComplianceReport>;
  forceCapture(): Promise<void>;
  retake(slot: Slot): void;
  flip(): Promise<unknown>;
  stats(): Stats;
  plan: Plan;
  readonly sessionId: string | null;
  readonly captured: CapturedSlot[];
  readonly state: string;
}

export function createPipeline(opts: {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  shape: PackShape;
  apiBase?: string;
  handlers?: PipelineHandlers;
}): Pipeline {
  return createPipelineJs(opts) as Pipeline;
}

export function buildPlan(shape: PackShape): Plan {
  return buildPlanJs(shape) as Plan;
}

const SLOT_LABELS = SLOT_LABEL as Record<Slot, string>;
const SEQUENCES = SURFACE_SEQUENCES as Record<PackShape, Slot[]>;

export { SLOT_LABELS as SLOT_LABEL, SEQUENCES as SURFACE_SEQUENCES, GUIDE, BORDER, STABLE_FRAMES };

// Where the FastAPI service lives.
//
// No dev rewrite: `output: "export"` makes next.config rewrites a no-op, so a
// rewrite would work in `next dev` and silently vanish in the build people
// actually ship. An absolute origin is honest in every mode. The server sets
// CORS allow_origins=["*"], so cross-origin is fine.
//
//   next dev        → nothing set, falls back to the run.sh port
//   next build      → set NEXT_PUBLIC_API_BASE, or leave it same-origin if you
//                     serve `out/` from FastAPI itself
//   Capacitor       → must set NEXT_PUBLIC_API_BASE; the bundle is file:// and
//                     "same origin" means nothing there
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "");
