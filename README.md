# Product Capture SDK

A guided, banking-KYC-style camera for photographing packaged food, and the
pipeline that turns those photographs into a Legal Metrology / FSSAI compliance
report.

The camera does not have a shutter button. It watches the frame, tells the user
the one thing that is wrong, and captures by itself once the pack has been
correctly framed and held still for a full second.

```
shape → guided capture → quality gates → enhancement → OCR → rule engine → report
```

---

## The one architectural rule

**Vision transcribes and measures. Python adjudicates.**

Nothing in the camera, the detector, or the OCR layer decides whether a pack is
compliant. They produce a record; `labelcheck.engine.evaluate` — a pure function
over that record — produces every verdict. This is inherited from LabelCheck and
it is the reason a model swap can never quietly change a legal outcome.

Verdicts are six-state, not two: `PASS`, `FAIL`, `REVIEW`, `INCOMPLETE`,
`UNREADABLE`, `CANNOT_COMPUTE`. "I could not read this" and "this is
non-compliant" are different answers and the report keeps them apart.

---

## Running it

```bash
./run.sh serve     # API + capture UI on http://localhost:8000
./run.sh test      # Python suite (23 tests)
./run.sh check     # browser core self-check (20 checks, needs node)
./run.sh all       # both
```

Then open <http://localhost:8000>.

> **Camera access needs a secure context.** `localhost` counts as secure; a LAN
> IP over plain HTTP does not, and `getUserMedia` will be refused by the browser
> with no prompt. To test on a phone, put it behind HTTPS or use an SSH tunnel.

### Dependencies

On a clean machine:

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
PC_PYTHON=python ./run.sh serve
```

This machine is not clean — OpenCV lives in Anaconda and FastAPI lives in the
agentic-rag virtualenv, so `run.sh` runs Anaconda's Python with the venv's
`site-packages` on `PYTHONPATH`. Override with `PC_PYTHON` and `PC_EXTRA_SITE`.

### LabelCheck

The compliance engine is a separate checkout. `src/productcapture/_labelcheck_path.py`
looks for a sibling directory (`../sih26034/src`, `../labelcheck/src`) and falls
back to whatever `LABELCHECK_SRC` points at:

```bash
LABELCHECK_SRC=/path/to/labelcheck/src ./run.sh serve
```

If it cannot find it you get an `ImportError` that names the variable, not a
confusing `ModuleNotFoundError` three imports deep.

---

## Optional backends

Everything runs without these; the service degrades honestly rather than
pretending.

| Feature | Install | Without it |
|---|---|---|
| OCR | `pip install -e '.[ocr]'` (PaddleOCR) | Falls back to the LabelCheck Gemini adapter, then to a deterministic offline path that returns a blank record with a note saying so |
| YOLO11 detection | `pip install -e '.[yolo]'` + `PRODUCTCAPTURE_YOLO_PATH=model.onnx` | Uses the model-free detector, which is what the browser uses anyway |

`GET /api/health` reports which OCR backend is actually live. The capture UI
shows it too, and warns you when it is `offline` — an offline run produces a
structurally valid report with every field empty, which is useful for testing
and useless for compliance.

---

## Slots vs surfaces

Two vocabularies that are deliberately not the same thing.

A **slot** is one step of the capture flow. A **surface** is what the rule engine
calls that face of the pack.

| Shape | Slots |
|---|---|
| `flat` | `front`, `back` |
| `cylindrical` | `front`, `side_1`, `back`, `side_2`, `top`, `base` |

A cylinder has two sides and both are `side` to the engine. Keying storage on
the surface name meant the second side silently overwrote the first, so slots
are distinct and `capture.surface_for_slot()` maps them down. `top` adjudicates
as `base`: LabelCheck has no lid surface, and "see lid for expiry" and "see base
of can" are the same instruction to the rules.

---

## Architecture

Each module does one thing and is callable on its own.

```
src/productcapture/
  app.py          FastAPI routes. Every HTTP concern, and nothing else.
  capture.py      shape → ordered slot plan. Pure map, no camera, no I/O.
  vision.py       packet detection. Model-free by default; YOLO11 ONNX optional.
  quality.py      the 15 gates: blur, exposure, glare, motion, geometry…
  enhance.py      perspective correct → denoise → sharpen → deglare → normalise
  ocr.py          PaddleOCR → Gemini → offline, with a per-slot .json cache
  compliance.py   OCR records → merge_surfaces → engine.evaluate → wire dict
  analytics.py    counters and p50/p95 latency
  schemas.py      the Pydantic wire contract

web/                    zero-build SDK — plain ES modules, no bundler, no npm
  index.html            shape selection
  capture.html          the camera UI
  core/
    constants.js        every threshold, shared by worker and UI so they cannot disagree
    detect.js           Sobel projection profile + structure-tensor tilt
    quality.js          JS twin of quality.py
    guidance.js         ranks reasons → one instruction + border colour
    automaton.js        the auto-capture hold
    camera.js           getUserMedia, frame grab, full-res still
    overlay.js          guide frame, box, arrows, progress ring, shutter flash
    worker.js           the Web Worker entry point
    pipeline.js         wires it all to the server
    selfcheck.mjs       `node web/core/selfcheck.mjs`

app/                    Next.js + Tailwind + Capacitor shell
  src/lib/core.ts       typed surface over web/core — the ONLY import boundary
  src/hooks/            useCapturePipeline: mirrors the pipeline into React state
  src/app/              shape picker, capture route
  src/components/       StepRail, CaptureTray, ReportView
```

`app/` imports `web/core/*` through the `@core/*` alias and `externalDir`. It
does not contain a second copy of the detection, quality, guidance, or
auto-capture logic — those exist once, in `web/core`, and `./run.sh check`
tests that one copy.

### Why the analysis runs in a Worker

Detection and the quality gates run off the main thread, so the video never
stutters and the overlay never drops a frame. Exactly one frame is in flight at
a time — queuing them would build a backlog on a slow device and the guidance
would start describing where the pack *was*, which is worse than analysing fewer
frames.

### Why detection is model-free

The overlay already asks the user to put one pack, centred, against a plainer
background. Under those conditions a Sobel edge-energy projection localises the
pack in ~3ms at 320px, with no model to download, no WASM to warm, and no
first-capture stall. `PRODUCTCAPTURE_YOLO_PATH` turns on a YOLO11 ONNX path
server-side when a real model is available.

The detector and the quality gates share **one** 320px greyscale buffer. They
used not to, and the box coordinates were being read against a different
resolution than the pixels — every frame came back "blurry" for reasons nothing
in the logs explained.

---

## The Next.js app (`app/`)

Two frontends, one core. `web/` is the zero-build SDK — open it and it runs.
`app/` is the same capture logic in a Next.js/Tailwind shell that Capacitor can
wrap into an iOS or Android binary.

```bash
cd app
npm install
npm run dev            # http://localhost:3000, expects ./run.sh serve on :8000
npm run typecheck && npm run build
```

`npm run build` is clean: three static routes, ~101kB first load. The Worker
survives the bundler — webpack rewrites `new Worker(new URL("./worker.js", …))`
into its own chunk with the whole `web/core` dependency graph inlined, and drops
`type: "module"` because it no longer needs ESM. That is the good outcome: a
classic worker runs on Firefox before 114, a module worker does not.

### Pointing it at the API

`API_BASE` in `src/lib/core.ts` defaults to `http://localhost:8000` in dev and
same-origin in a build. Override with `NEXT_PUBLIC_API_BASE`:

```bash
cp .env.example .env.local     # then edit
```

There is deliberately **no dev rewrite**. `output: "export"` makes `next.config`
rewrites a no-op, so a rewrite would work under `next dev` and silently vanish
from the bundle people ship. The server sets `allow_origins=["*"]`, so a plain
absolute origin works in every mode. For Capacitor it is *required* — the bundle
loads from `file://`, where same-origin means nothing.

### Native

```bash
npm run build          # → app/out
npx cap add ios        # or: android    (once)
npm run sync:ios       # copies out/ into the native project
npx cap open ios
```

Camera permission strings are not optional — the OS kills the app without them:

- **iOS** `ios/App/App/Info.plist` → `NSCameraUsageDescription`
- **Android** `android/app/src/main/AndroidManifest.xml` → `<uses-permission android:name="android.permission.CAMERA" />`

On device, `NEXT_PUBLIC_API_BASE` must be a LAN or public **HTTPS** origin.
`localhost` on a phone is the phone. Android also blocks cleartext HTTP by
default, and `getUserMedia` needs a secure context regardless.

## The capture loop

Per analysed frame:

1. `camera.grab()` — downscaled RGBA off a small canvas
2. transferred to the worker (zero-copy)
3. `toWorkingGrey` → `detectFrame` → `assessQuality` → `guidanceFor`
4. the automaton takes the verdict; any bad frame resets the hold to zero
5. the overlay draws the box, the arrow, the ring, the border colour

The hold is counted in **analysed frames**, not wall clock, so a slow device
holds for a genuine second of evidence instead of firing on three frames spread
over a second.

Auto-capture requires all of: packet present, correct size, centred, sharp,
correctly exposed, no glare, and stable — continuously, for 25 frames.

### Review before submit

Every shot is shown full-size the moment it is taken, with **Retake this one**
beside **Looks good**. When the last slot lands, the session stops at a review
grid of all the photographs and waits for **Submit for compliance**.

Compliance does not run on its own. The entire report is derived from these
images, and a blurred back-of-pack yields a confident `FAIL` that is really an
OCR miss — the most expensive kind of wrong answer this system can give. One
look at the photograph costs a second; unpicking that verdict costs far more.

The capture cursor is derived from which slots have photographs, not
incremented — so a retake re-shoots exactly one surface and returns to the
review, rather than marching forward through slots that are already done.

Analysis pauses while the review is open and resumes on retake. The stream
itself stays live: dropping it would re-prompt for camera permission, and on
iOS that prompt cannot be re-answered without a user gesture.

### Guidance

One instruction at a time, ranked most-blocking-first. Telling someone to "move
left and increase lighting and hold steady" at 25fps reads as noise; a KYC
camera names one correction, the user fixes it, the next one appears.

Border colour: **red** invalid · **amber** close · **green** ready.

---

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | status, live OCR backend, rule count |
| `POST /api/session` | `{shape}` → session id + slot plan |
| `GET /api/session/{id}` | captured slots, completion |
| `POST /api/capture` | `{session_id, slot, image_b64}` → stored + quality |
| `POST /api/compliance` | OCR every slot, merge, adjudicate |
| `GET /api/compliance/{id}` | the stored report |

Sessions are an in-memory dict — they reset on restart, which is right for a dev
server and a kiosk. Swap `_SESSIONS` for a shelve or sqlite store with the same
dict interface if you need persistence.

---

## Testing

`./run.sh test` covers the plan, detection, the quality gates, enhancement, and
the full HTTP flow end to end including a real compliance run.

`./run.sh check` covers the browser core, which the Python suite cannot reach:
that detection finds a synthetic pack and returns coordinates inside the working
buffer, that the gates complain correctly about distance and light, that
guidance never names two directions at once, and that the automaton fires once
after a full hold, resets on a bad frame, and does not double-fire while a
capture is in flight.

---

## Known ceilings

Marked `ponytail:` in the source where they bite.

- **Session store and analytics use one global lock.** Fine to a few hundred
  concurrent captures; go per-session if throughput matters.
- **Detection assumes one dominant pack.** Two packs in frame read as one wide
  box; `multiple_packets` catches the obvious case, a model catches the rest.
- **Distance is an estimate from apparent area**, calibrated so a pack filling
  ~45% of frame reads ~20cm. The UI labels it approximate. Real depth needs
  camera intrinsics or a reference object.
- **No stitching yet.** Cylindrical capture stores six discrete surfaces and
  adjudicates them merged; it does not build a single unwrapped panorama.
