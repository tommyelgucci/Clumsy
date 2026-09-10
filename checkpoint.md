# Checkpoint — Progress log

### 2026-09-10 — Task 2.7 (new): bucket fill — tolerance, edge expansion, real gap closure, reference-layer fill

Owner brought two feature ideas from a reference video (a smart bucket
tool, and an audio timeline), both written up as prompts addressed to
"Trace." Confirmed they were meant for Clumsyloop, then split the
decision in two rather than building either one blind: bucket fill fits
what CLAUDE.md already says this app draws (dialogue bubbles, illustrated
backgrounds — flat-color fills are exactly that workflow); an audio
timeline doesn't — `document.ts` already cut `AudioTrack` from v1 scope on
purpose, and there's no multi-frame timeline UI in Clumsyloop at all yet
for anything to scrub across. Owner chose to build both anyway; this
entry covers the bucket tool. The audio timeline is real, larger, blocked
work of its own — not started this session, flagged here so intent isn't
lost.

Read Trace's actual shipped implementation before porting anything
(`core/flood.ts`, `workers/floodFill.worker.ts`, and `Engine.floodFill`'s
call site) rather than assuming the reference video's feature list maps
1:1 onto what Trace has. It didn't: Trace's own bucket tool only has
tolerance + edge expansion/bleed (`growFilled`, which grows the FILLED
region after the scanline fill already ran) — no actual gap closure.
A real break in the line still leaks a plain tolerance flood right
through it in Trace today. Since gap closure was one of the two features
the owner explicitly asked for, shipping only tolerance+bleed here would
have quietly under-delivered while looking complete. Built it for real
instead:

- `buildWallMask` — the exact inverse of `floodMatch`'s per-pixel
  tolerance test: 1 where a pixel differs from the seed color by more
  than tolerance (a "wall" the fill can't cross), 0 where it can.
- `closeGaps` — a genuine morphological close (iterated 3x3 dilate, then
  the same count of 3x3 erode passes) on that wall mask, bridging breaks
  up to about `2*radius` pixels without permanently widening the wall
  anywhere a gap didn't need bridging. Same "iterate a 1px-radius
  operation `n` times instead of a bigger kernel" style `growFilled`
  already uses, for consistency.
- `floodOpenMask` — the same scanline algorithm as `floodMatch` (pulled
  out into a shared `scanlineFill` so both share one tested core), but
  flooding over the closed wall mask instead of re-testing color per pixel.

This is a real pipeline addition beyond what Trace ships, not a redesign
of what got ported — `floodMatch`/`growFilled`/`applyFillColor`/`extractRect`
are otherwise verbatim ports (English comments only), same exception
`brush.ts`/`palettes.ts` already have.

`gl/renderer.ts` gained `writeRect` (sub-rectangle GPU write-back,
`readRect`'s missing other half — needed since a fill only ever touches
a small bounding box, not the whole cel). `workers/floodFill.worker.ts`
runs the whole wall→close→flood→grow→paint pipeline off the main thread,
same reasoning Trace's version gives (CPU-heavy, no WebGL/DOM needed,
doesn't want to share the GPU context). `gl/engine.ts` gained `floodFill`:
reference = the whole composited document at the current frame (any
visible layer's ink bounds the fill, not just the active layer's own
cel — the reference-layer-fill behavior); the write always goes to the
active layer's cel. No-op on a locked/hidden/non-`draw` layer, no undo —
consistent with how strokes already work in this engine (see 2.6).

`Engine.activeLayerId` was `readonly` since task 2.6 — changed to a
getter + new `setActiveLayer()` method, purely so reference-layer fill
had any way to be exercised at all: `DrawingCanvas` still only ever
creates one fixed layer (no layers panel yet), so a person can't actually
reach this behavior through the UI today. Named honestly rather than
quietly left implicit — the engine is correct, there's just no UI yet
that lets two layers coexist.

New `state/tool.ts` field: `mode: 'draw' | 'bucket'`. `DrawingCanvas.tsx`
gained a Draw/Bucket toggle and three sliders (tolerance, expand, gap
closure) — a bucket tap doesn't set pointer capture or track a drag,
just fires `floodFill` once.

Verification: 11 new tests in `core/flood.test.ts` (the refactored
`floodMatch` re-checked unchanged; `buildWallMask`/`closeGaps`/
`floodOpenMask` proven directly — a synthetic ring with a real 1px gap
leaks with a plain tolerance flood and is correctly contained once
`closeGaps` runs first). `npm test` is 131/131.

The browser-level verification (`scripts/bucket-smoke.mjs`, Playwright)
surfaced two real bugs along the way, neither one in the flood-fill code
itself:

1. **The UI's fill is fire-and-forget.** `DrawingCanvas`'s click handler
   calls `void engine.floodFill(...)` without awaiting it (a Worker round
   trip), so a plain `page.mouse.click()` returns long before the fill
   lands. Checking pixels immediately produced nonsense (a fill from one
   test appearing to leak into a LATER test's region, once it finally
   resolved). Fixed the test by polling the filled cel's own
   `surface.version` (bumped by `writeRect`) instead of checking
   immediately or guessing a sleep duration.
2. **The brush engine's One Euro smoothing filter has genuine
   steady-state lag behind constant-velocity motion** — confirmed
   directly, bypassing Playwright entirely, by calling
   `engine.beginStroke`/`pushStroke`/`endStroke` with dense synthetic
   samples along a straight line: the drawn line stopped several pixels
   short of the declared endpoint regardless of sample density, only
   fixed by adding samples that "dwell" at the target instead of adding
   more samples in transit. This is expected, correct behavior for a
   low-pass filter smoothing pointer input (ported verbatim from
   Trace, "battle-tested" per CLAUDE.md) — a real hand naturally slows
   down at the end of a stroke; a scripted drag that stops moving the
   instant it arrives doesn't. Fixed the test's `dragStroke` helper to
   dwell at each stroke's endpoint, not the brush engine.

A third issue was a plain test-authoring mistake, not a finding: an early
draft of the gap-closure rectangle used `x` coordinates up to 420 on a
360px-wide document — silently drew nothing there at all. Caught by
scanning the actual rendered pixels directly rather than trusting the
coordinates on paper.

`scripts/bucket-smoke.mjs` re-runs `renderer-smoke`/`persistence-smoke`/
`drawing-smoke` alongside it each time it was iterated on — all four
Playwright smoke tests pass together, re-run twice for the new one to
rule out flakiness. `npm run build`/`lint`/`test` all clean.

**Marked 2.7 `done`** in `tasks.json`.

---

### 2026-09-09 — Task 2.6 (new): the drawing UI — brush.ts and palettes.ts finally have a consumer

Asked what else to build while phase 1 stays blocked on device access.
Offered three camera-independent options (Firestore rules, the web half
of export, the drawing UI); owner picked the drawing UI — the actual
product differentiator, not backend or export plumbing, and the one that
turns two already-ported-but-unused pieces (`core/brush.ts`,
`state/palettes.ts`) into something a person can actually use. Added as
task 2.6 in `tasks.json` since it wasn't itemized there originally — the
2.1 checkpoint entry from 2026-08-16 already flagged `brush.ts` as
"groundwork for whichever future task actually builds the drawing UI,"
so this fills that named gap rather than inventing new scope unprompted.

New `gl/engine.ts` — deliberately NOT a port of Trace's `core/engine.ts`.
Trace's engine carries revision/`touch()`/subscribe pub-sub (the pattern
`CLAUDE.md`'s architecture section already documents) because many
independent UI pieces there — layers panel, undo button, timeline — all
react to document mutations outside React's own state flow. Clumsyloop's
engine has exactly one consumer so far, the canvas itself, and it updates
imperatively (`renderAndPresent()`, called directly after every stroke
mutation) — no second listener exists yet to justify the pub-sub
machinery. Documented as the reason to add it on `Engine` itself, for
whoever builds the first thing (a layers panel, a frame counter) that
actually needs it. Also NOT ported: Trace's wet-stroke staging surface
(a stroke there lives on a scratch surface until pointer-up, needed for
pigment-mix blending and a "cancel this stroke" gesture) — here, stamps
go straight onto the permanent cel as they arrive. Real, named
consequence: the one `brush.ts` preset that wants pigment-mix blending
("Watercolor", `pigmentMix: 0.15`) paints correctly shaped/colored
stamps but without the subtractive-mix merge Trace's `mixOver` gives it.
No undo yet either — `history.ts` exists but isn't wired to the engine.
Single fixed "Ink" draw layer, single frame (frame 0) — no timeline, no
camera layer; those need the capture UI (task 2.3), still blocked.

`Renderer.drawStamps` (task 2.2) gained an `erase` parameter — `brush.ts`
ported two eraser-category presets back in the 2.1 pass, but nothing had
ever exercised that code path since drawStamps only ever did plain
src-over accumulation. Erase mode switches to
`blendFunc(ZERO, ONE_MINUS_SRC_ALPHA)`, same trick `drawOver`'s existing
`erase` parameter already uses — the stamp's alpha coverage still comes
from the same shader, only the destination blend changes.

New `state/tool.ts` (active brush id + color, Zustand) — same "split out
because Trace's `store.ts` mixes this with panel/quick-shape/rig state
Clumsyloop doesn't have" reasoning `palettes.ts`'s own header comment
already gives. New `ui/DrawingCanvas.tsx` wires pointer events to the
engine: tilt→altitude/azimuth conversion and the mouse/pen pressure
default are ported directly from Trace's `ui/CanvasView.tsx`
(`tiltToSpherical`) rather than re-derived, since `brush.ts`'s tilt-aspect
math expects that exact convention. Brush picker groups `DEFAULT_BRUSHES`
by `BRUSH_CATEGORIES`; color picker reads `usePalettes`'s curated
`paletteGroups` plus a native `<input type="color">` for anything outside
the curated set. Mounted above the existing camera/renderer/persistence
harnesses in `App.tsx` — it's real product UI now, not one more manual
test harness, so it leads the page instead of stacking at the bottom.

Verified with real pointer events, not synthetic `Stamp[]` arrays (unlike
`renderer-smoke.mjs`): a new `scripts/drawing-smoke.mjs` drags the mouse
across the actual on-screen canvas and reads back the result via
`renderer.toImageData()`. First pass measured a plain average over a
40×40 box around the stroke and got a false failure — a 6px-diameter
pencil line only covers a sliver of a box that size, so the average
washes out close to white even though the stroke drew correctly (checked
directly: dark ink was there, at R=41). Fixed by scanning for the
darkest pixel in a band around the expected line instead of averaging —
answers "is there ink here" without needing to know the exact line
width or pixel-perfect position. Confirms: a stroke draws visible dark
ink; switching color mid-session changes the next stroke's color while
leaving the earlier stroke byte-for-byte unchanged; the eraser brush
removes ink instead of adding color; Clear resets the layer. All three
Playwright smoke tests (`test:renderer-smoke`, `test:persistence-smoke`,
`test:drawing-smoke`) pass together, confirming no regressions.

`npm run build`/`lint`/`test` all clean (120/120 unit tests, unchanged —
this task's logic is pointer-driven, not unit-testable the way pure
`core/` modules are, same reasoning `document.test.ts` already gives for
deferring `Surface`-touching behavior to browser verification).

**Marked 2.6 `done`** in `tasks.json`.

---

### 2026-09-08 — Task 2.5: local project persistence (save/resume, IndexedDB)

Owner asked to keep pushing the engine forward while phase 1's device
verification stays blocked, same reasoning as 2.1/2.2 — this time
targeting 2.4/2.5 specifically to steer clear of anything camera-coupled.
2.4 (native `.mp4` export via AVFoundation/Swift) shares phase 1's actual
limitation — this environment can write Swift but can't build or run it —
so only 2.5 got built. Before touching code, asked the owner one real
architecture question `RUMBO.md`/`CLAUDE.md` didn't settle: IndexedDB
(Trace's own approach, no new dependency) vs. Capacitor's Filesystem
plugin (more reliable for "hundreds of photos" surviving force-quit on a
device with little space, per RUMBO.md's own stated business risk, but a
new native dependency this session can't verify on hardware). Owner chose
IndexedDB to start.

Split three ways, matching CLAUDE.md's "`gl/` is the sole point of
contact with WebGL" literally rather than the way Trace's own `io.ts`
does (Trace's `io.ts` calls `engine.renderer.toImageData()` directly):

- `core/io.ts` — pure: JSON-safe document/layer/transform metadata
  (de)serialization, and PNG encode/decode via `upng-js` (new
  dependency). Chose `upng-js` over Trace's `canvas.toBlob()` specifically
  so this file gets real `npm test` coverage (no DOM canvas under Node) —
  already the library RUMBO.md's known-debts note pointed at for exactly
  this task, not a fresh choice made now. Found a real bug in
  `upng-js@2.1.0` along the way: with `cnum=0`, `encode()` still
  auto-selects palette mode (ctype 3) whenever a frame has ≤256 unique
  colors, and this version's `decode()`/`toRGBA8()` crashes on its own
  palette output (`out.data` comes back `undefined` — confirmed against a
  bare encode/decode round trip with nothing else involved). Worked around
  by passing `forbidPlte: true` — encode's 6th argument, present in the
  actual library but missing from `@types/upng-js`'s declarations, so
  `core/io.ts` casts a narrow local type for just that call rather than
  reaching for `any`. Forcing truecolor+alpha this way is also just
  correct for this project regardless of the bug: a flat-colored drawn
  cel is exactly the kind of content that would trip ≤256-color palette
  selection, and lossless round-tripping matters more here than the
  handful of bytes palette mode would have saved.
- `gl/projectIO.ts` — the GPU-facing glue `core/io.ts` can't own:
  `captureProject` reads every non-empty cel's pixels off the GPU
  (`renderer.toImageData`) and hands them to `core/io.ts` to encode;
  `restoreProject` decodes each saved PNG and uploads it into a freshly
  created `Surface` via a new `Renderer.uploadPixels` method (raw-pixel
  sibling to task 2.2's `uploadImage`, added here since decoded PNG bytes
  aren't an `ImageBitmap`/canvas — premultiplies in JS rather than
  trusting `UNPACK_PREMULTIPLY_ALPHA_WEBGL` for a raw `ArrayBufferView`
  source, which isn't as clearly specified as it is for an image source).
- `state/projectStore.ts` — IndexedDB, a single key-value object store
  keyed by project id, same shape as Trace's autosave. Degrades to a
  no-op when `indexedDB` isn't available, same guard `palettes.ts`
  already established for `localStorage` under Node. Cels stored as
  `[celId, bytes][]` pairs rather than a `Map` directly — `Map` is
  structured-cloneable in IndexedDB on modern engines, but that can't be
  confirmed on an actual WKWebView from this environment, so this sticks
  to a shape IndexedDB has always supported instead of assuming.

No history persistence, no zip container, no bone rigs/masks/text/
adjustment/audio/custom-texture export — none of that exists in
Clumsyloop yet or is in v1 scope; the acceptance criteria is "frame by
frame, exactly as it was" for frames + layers + metadata, not the undo
stack.

Verification: `core/io.test.ts` (9 new tests — metadata round-trip
including transform keyframes, cel placements flattened with no
`Surface` attached, PNG round-trip including the palette-bug regression
case) runs under plain `npm test`, no browser needed — `npm test` is
120/120 now. The GPU + IndexedDB path needs a real browser (this
environment has no physical device either — see `CLAUDE.md`), so it's
verified the same way task 2.2 was: a `PersistenceHarness` component
(`window.__clumsyloopPersistence`) builds a two-frame camera layer + one
draw layer, saves it, and a new `scripts/persistence-smoke.mjs`
(Playwright + SwiftShader, `npm run test:persistence-smoke`) drives a
full page reload — the closest proxy this environment has for "force-quit
and relaunch" (IndexedDB and `localStorage` both survive it the same way
they survive a real force-quit, unlike JS/WebGL state) — and confirms
every field and every composited pixel survives.

Getting that smoke test green surfaced two real bugs worth calling out,
not just the upng-js one above:

1. **A race in the test setup, not the app**: clearing IndexedDB/localStorage
   right after `page.goto`'s `networkidle` fires still raced against the
   *first* page load's own in-flight async save — its tail end would
   overwrite the just-cleared `localStorage` flag a moment later.
   `networkidle` resolves long before IndexedDB writes finish; fixed by
   waiting for the harness's own "I'm done" signal before clearing
   anything, not a fixed delay.
2. **A real aliasing bug in `Renderer.renderDocumentFrame` (task 2.2)**:
   its returned surface is one of the renderer's own reused scratch
   buffers. Rendering frame 0 then frame 6 back to back and holding both
   return values looked fine until frame 6's render silently overwrote
   frame 0's — both calls' clip-group count gives the ping-pong pool the
   same parity, so they alias the same physical surface. Not a 2.5 bug,
   but 2.5 is the first caller that ever needed two rendered frames alive
   at once, which is exactly why 2.2's own smoke test never caught it.
   Fixed by copying each frame's result into its own dedicated surface
   immediately (`PersistenceHarness`'s `renderBothFrames` helper) and
   documented the aliasing contract directly on `renderDocumentFrame`
   itself so the next caller doesn't rediscover it the same way.
   `test:renderer-smoke` still passes unchanged — that harness only ever
   rendered one frame, so it was never exposed to this.

`npm run build`/`lint`/`test` all clean; `test:renderer-smoke` and the
new `test:persistence-smoke` both green, re-run twice to rule out
flakiness in the reload-based verification.

**Marked 2.5 `done`** in `tasks.json`, ahead of 2.3 per the same explicit
early-start exception 2.1/2.2 used. 2.4 (export) is still `pending` —
that one's blocked on the same device access phase 1 is.

---

### 2026-09-07 — Task 2.2: WebGL2 renderer, compositing camera frame + drawn layers

Built `gl/shaders.ts` and replaced the `gl/renderer.ts` stub (which so far
only had the `Surface` type, for `document.ts`'s type-only dependency)
with a real `Renderer`. Ported from Trace's `gl/renderer.ts`/`shaders.ts`
(same owner, in this session's repo scope), trimmed hard — all cuts
listed and reasoned about in `renderer.ts`'s own header comment, not just
here: no GPU texture residency budget/eviction/CPU backing (Trace counts
texture bytes because a rig-heavy project keeps dozens of surfaces alive;
Clumsyloop's real memory question is different — a stop-motion project is
"hundreds of photos" per RUMBO.md, each a full-document camera Cel — but
building an eviction pool now, before task 2.3's capture UI exists to
generate real frame counts to profile against, would be guessing at a
solution before the problem's actual shape is known; flagged as a debt,
likely lands in 2.3 or 2.4), no mesh skinning/rig, no adjustment layers,
no selection outline, no pigment-mix wet blending (one ported `brush.ts`
preset, "Watercolor", sets `pigmentMix: 0.15` — `drawStamps` still paints
its stamps correctly, just without the subtractive-mix merge pass, which
is the future drawing UI's job, not this renderer's), no thumbnail
downscaling (task 2.3, "filmstrip thumbnail strip", is the first actual
caller — building it now with nothing to verify against risks getting the
ink-bounds cropping subtly wrong unnoticed). Kept in full, not trimmed:
all 13 `BlendMode`s and brush stamping (`drawStamps` + `getBrushTexture`),
since `types.ts` and the already-ported `brush.ts` commit to both.

Redesigned the `Surface` stub along the way — it was only a placeholder
interface (`{width, height, texture, version}`), never used by any real
code, so nothing outside `renderer.ts` depended on its shape (confirmed:
`document.ts` only imports it as a type, and `document.test.ts` already
avoids touching `.surface` by design). The new `Surface` is a class
holding a texture + FBO, matching Trace's invariant that every surface is
exactly document-sized — no per-surface width/height. That means a
captured photo has to already be sized to the document before it becomes
a camera Cel; the resize step itself is capture-UI glue, task 2.3's job.

Added a document-level composition entry point, `Renderer.renderDocumentFrame(doc, frame)`,
that Trace itself keeps in a separate `engine.ts` rather than
`renderer.ts` — folded into this file instead since Clumsyloop doesn't
have an `engine.ts` yet and task 2.2 in `tasks.json` only names
`renderer.ts`; splitting one out now, with no second caller yet to
justify the boundary, would be the premature-abstraction mistake the
project is trying to avoid elsewhere. Ported and trimmed from Trace's
`engine.ts` `compositeGroups`/`rasterizeLayer` (clip groups resolved
against their base layer, then composited onto the accumulator bottom to
top) — with no wet-stroke live-compositing, no onion-skin ping-pong, no
active-layer cache-boundary optimization, since none of those exist here
yet. Layer transforms (`TransformTrack`, kept in `document.ts` for future
effects/dialogue-bubble animation) are honored via the same
rotate/scale-about-center matrix Trace hand-rolls, reproduced here instead
by composing two existing `math.ts` helpers (`mat3FromTRS` + `mat3Multiply`)
— confirmed algebraically equivalent before using it, rather than hand-rolling
a third copy of the same arithmetic.

Visual verification (this environment has no physical device, same as
phase 1 — see `CLAUDE.md`) done headlessly: a new `ui/RendererHarness.tsx`
component builds a tiny synthetic document (one camera Cel — a
four-quadrant synthetic "photo", standing in for
`CameraCapture.capturePhoto()`, chosen specifically because a solid-color
photo can't catch an orientation flip — plus one draw Cel, a real
`StrokeBuilder`-generated pencil stroke) and composites it, exposing
`window.__clumsyloop` for scripting. `scripts/renderer-smoke.mjs`
(Playwright + SwiftShader, `npm run test:renderer-smoke`, new devDependency
`playwright` at Trace's same pinned version) drives it and reads back with
`renderer.toImageData()` rather than screenshotting the live canvas — the
same `preserveDrawingBuffer: false` trap Trace's `CLAUDE.md` documents
(a canvas screenshot can lag a frame behind; `readPixels` doesn't). All
checks pass: every quadrant keeps its own color (no orientation flip),
the stroke reads clearly darker than the photo underneath it (compositing
works), and the area just beside the stroke matches the plain photo color
with no dark fringe (no color-halo bug from a premultiplication mistake).
A screenshot taken the same way, for human eyeballing, confirms the same.

Mounted `RendererHarness` into `App.tsx` below the existing phase-1
camera-plugin buttons, matching that file's own framing
("manual test harness ... not the real capture UI") rather than starting
a second entry point for one more manual test.

`npm run build`, `npm run lint`, and `npm test` (111/111, unchanged) all
pass clean; `npm run test:renderer-smoke` needs `npm run dev` running
separately, same convention as Trace's own Playwright scripts.

**Marked 2.2 `done`** in `tasks.json`.

---

### 2026-08-16 (later once more) — Ported brush.ts, brushTexture.ts, and the palette system directly

The one explicit exception in `CLAUDE.md`: unlike `document.ts`, these
port as-is, no redesign — they have nothing to do with the camera or
monetization. Not tied to a `tasks.json` line item (that document only
lists 2.1-2.5; brushes/palettes are the standalone exception `CLAUDE.md`/
`RUMBO.md` call out), so nothing there changed — this is groundwork for
whichever future task actually builds the drawing UI.

`src/core/brushTexture.ts` (procedural stamp-texture generators: grain,
chalk, canvas, splatter, flat, plus parametric/streak/wisp/burst/rake/
cluster generators for a future custom-brush editor) and
`src/core/brush.ts` (`DEFAULT_BRUSHES` — 23 presets across the 5
categories, `StrokeBuilder`, `taperScale`) ported close to verbatim from
`tommyelgucci/Draw`, comments and preset names translated to English,
every numeric value and all logic untouched. `CustomTexture` (imported
brush textures) came along with `brushTexture.ts` since it's part of the
same file, but isn't wired into `ClumsyloopDocument` yet — that document
type deliberately dropped `customTextures` in the 2.1 pass as out of v1
scope, so this sits unused until/unless a future task decides to support
custom texture import.

The palette system went into a new `src/state/palettes.ts` rather than a
full port of Trace's `state/store.ts` — that file mixes palettes with
tool selection, panels, quick-shape settings, rig/IK state, none of which
exists yet for Clumsyloop (that's task 2.3, the capture UI, not built).
Ported `PaletteGroup`/`UserPalette`, the 16 curated palettes (same color
data — same owner across both repos, so this is moving their own
creative judgment between their own projects, not a licensing question),
and the `localStorage`-backed CRUD as a standalone Zustand store
(`usePalettes`). Storage key renamed to `clumsyloop:palettes`.

Added test coverage Trace itself doesn't have for these files (it relies
on Playwright visual scripts instead) — `brush.test.ts` (preset sanity,
`taperScale` bounds, `StrokeBuilder` basics),
`brushTexture.test.ts` (determinism, buffer sizing, non-empty coverage
per built-in texture), `palettes.test.ts` (palette-group data sanity,
full CRUD). `usePalettes`'s tests run without a real `localStorage` (not
available under `node --test`) — `loadUserPalettes`/`saveUserPalettes`
already catch that and degrade to an empty list, by design, so only
persistence itself goes untested here, not the state transitions.
`npm test`'s glob extended to also pick up `src/state/*.test.ts`.

`npm test` 111/111, `npm run lint` and `npm run build` clean. One real
bug caught by the new tests, not a port error: my own first draft of
`begin() with a single tap...` in `brush.test.ts` assumed the stamp
lands exactly on the tap point, forgetting the default pencil preset has
`scatter: 0.05` — fixed the test (explicit `scatter: 0`), not the code.

---

### 2026-08-16 (later still again) — Task 2.1: ported and trimmed core/ from Trace

Owner asked to look at what could start now, easiest to hardest, rather
than wait on phase 1's device verification. Task 2.1 was the answer:
`types.ts`/`math.ts`/`document.ts`/`history.ts` are pure TypeScript, no
DOM, no native code — nothing about them depends on whether the camera
lock turns out to flicker-free on a device, so building them now doesn't
risk the kind of wasted work RUMBO.md warns about for the rest of the
engine.

Ported from `tommyelgucci/Draw` (Trace), which is in this session's repo
scope, so this was a real port from the actual source, not a guess at
what Trace looks like. `types.ts` and `math.ts` ported close to verbatim
(comments translated to English) — they're generic engine plumbing with
no Clumsyloop-specific shape. `document.ts` did **not** port 1:1 on
purpose: Trace's version (468 lines) carries a lot that's out of
Clumsyloop's v1 scope per `CLAUDE.md` — bone rigs/skeletons, sprite-swap
catalogs for lip sync, text layers, adjustment layers, layer masks, layer
folders, an audio track. All cut, not forgotten — porting them would
throw work at features the owner explicitly excluded from v1. What did
change on purpose, not just trim: `LayerKind` is `'camera' | 'draw'`
instead of Trace's `'draw' | 'reference' | 'adjustment'` — a camera layer
holds the stop-motion photo sequence, a draw layer holds hand-drawn cels
(rotoscoping, effects, dialogue bubbles, backgrounds), and that split is
Clumsyloop's actual differentiator, not Trace's. Kept the
`Channel`/keyframe/easing system from Trace's `TransformTrack`, since
effects and dialogue bubbles plausibly need to animate in/out — unlike
Trace, this isn't for rigged character motion here. Default document size
also changed from Trace's 1920x1080 (landscape, tablet drawing tool) to
1080x1920 (vertical, matching the TikTok/Reels audience `CLAUDE.md`
describes). `history.ts` ported with one piece deferred: Trace's
`Command.op` field (lets some undo steps rebuild from a saved `.trace` on
load) depends on `historyOps.ts`/`io.ts`, which is task 2.5 (local
persistence) — not built yet, so `op` isn't there yet either.

`gl/renderer.ts` got a minimal `Surface` type stub — just enough for
`document.ts`'s type-only dependency (a Cel holds a Surface) to compile.
The actual WebGL2 implementation is task 2.2, untouched here.

Set up test infra mirroring Trace's exactly: Node's native test runner
via `node --test`, with the same `ts-extension-resolve.mjs` resolution
hook (Node's ESM loader needs the `.ts` extension on relative imports;
the rest of the codebase omits it, bundler-resolution style, so this
hook falls back to trying `.ts` when normal resolution fails). Added
`src/**/*.test.ts` to `tsconfig.app.json`'s exclude, same as Trace, so
`tsc -b` doesn't need `@types/node` just to build the app.

`npm test` passes 82/82 (30 in math.test.ts, 41 in document.test.ts
including the camera-cel/drawn-cel compositing test task 2.1's acceptance
criteria calls for by name, 11 in a new history.test.ts — Trace's
history.ts has no test file to port from, so these are new). `npm run
lint` and `npm run build` also pass clean.

**Marked 2.1 `done`** in `tasks.json`, ahead of `depends_on: 1.3` actually
being verified — a deliberate exception on the owner's explicit
instruction, not an oversight of the project's own ordering rule. Flagged
in the task's `verify_note`: this specific task is low-risk to have
built early since it's native/WebGL-free, unlike 2.2 onward.

---

### 2026-08-16 (later again) — Removed the GitHub Pages preview

Owner tried it (confirmed both the UI loading and the expected
"not implemented" behavior on the camera buttons) and decided it wasn't
worth keeping — it only ever proved the web build compiles, which the
`ios-build.yml` CI job and local `npm run build` already cover. Removed
`.github/workflows/deploy-pages.yml` and the `GITHUB_PAGES`-conditional
`base` in `vite.config.ts` that existed only for it. `ios-build.yml`
(the actual useful one — compiles the Swift/Obj-C on every push and PR)
stays.

**Left over, not cleaned up here**: the `github-pages` deployment
environment and the Pages "Source: GitHub Actions" setting are still
configured on GitHub itself — nothing in this repo can undo that, it's
a Settings → Pages change the owner would make by hand if they want it
fully gone, not just unused.

---

### 2026-08-16 (yet later) — GitHub Pages preview + an iOS compile-check CI job

Owner asked to try GitHub Pages to test the app. Flagged upfront that
this can't verify anything camera-related — `CameraCapture` is a native
Swift plugin with no web fallback, so its buttons will just surface a
"not implemented" error in a browser — and the owner asked for both: the
Pages preview (for the UI) and, in parallel, a way to at least start
closing the "never actually compiled" gap that's been open since task
1.2.

Added `.github/workflows/deploy-pages.yml` — builds with
`vite.config.ts`'s `base` set to `/Clumsy/` (only under `GITHUB_PAGES=true`,
so the Capacitor build stays at `/`) and deploys via the standard
`actions/upload-pages-artifact` + `actions/deploy-pages` pair. **One
manual step is still needed that no tool here can do**: Settings → Pages
→ Build and deployment → Source: GitHub Actions, on the actual GitHub
web UI. The workflow will fail until that's flipped once.

Added `.github/workflows/ios-build.yml` — runs on `macos-latest`,
`xcodebuild`s the `App` scheme against a generic iOS Simulator
destination with signing disabled. This is a real, if partial, answer to
the "unverified" caveat repeated in every phase-1 checkpoint entry: it
will catch a Swift/Obj-C compile error in `CameraCapturePlugin`
automatically, on every push and on PR #1. It does **not** touch a real
camera or prove anything about task 1.3's flicker check — the simulator
has no camera, same limitation as always. Physical-device verification
is still the only thing that can close out phase 1.

---

### 2026-08-16 (even later) — Evaluated four external repos for inspiration/reuse

Owner asked to check whether easings.net, open-brush, UPNG.js, and
ccapture.js were CC0 or permissive enough to pull ideas or code from.
Checked actual LICENSE files (not from memory): easings.net is
GPL-3.0 — dropped entirely, no further consideration, and its Penner
easing curves don't need porting from anywhere anyway (they're
standard 1-3 line formulas with no protectable expression; write them
fresh in `core/math.ts` whenever a specific tweened feature — a dialogue
bubble entrance, an effect fade — actually needs one, not before).
open-brush (Apache-2.0), UPNG.js (MIT), and ccapture.js (MIT) are all
genuinely permissive.

Of those three, only UPNG.js has concrete near-term value — noted in
`RUMBO.md` as the library for task 2.5 (local persistence, thumbnails)
or a future raw-sequence export. ccapture.js's actual code doesn't
port (it targets canvas capture in-browser, not this project's
AVFoundation export path), but its GPU motion-blur-accumulation
technique is worth keeping as a named v2+ feature idea, also noted in
`RUMBO.md`. open-brush yielded nothing concrete — Unity/C# 3D VR
painting tool, wrong stack, and the brush system is already solved via
the direct port from Trace — discarded, no note needed.

---

### 2026-08-16 (later still) — Task 1.3: exposure/focus/white-balance lock

Added `lockCaptureSettings()`/`unlockCaptureSettings()` to
`CameraCapturePlugin.swift` — this is the piece `RUMBO.md` calls out as
the actual make-or-break bet, so it got more care than a bare
`exposureMode = .locked`. Locking waits for `isAdjustingExposure`/
`isAdjustingFocus` to settle first (KVO observers on the
`AVCaptureDevice`, with a 1.5s timeout fallback so a device stuck
"adjusting" can't hang the call) before freezing exposure, focus, and
white balance via `lockForConfiguration()`. Locking mid-adjustment would
freeze a transient value instead of a converged one — exactly the kind
of subtle bug that would look fine in a code read and wrong on a device.
`unlockCaptureSettings()` reverts to the three continuous-auto modes, for
starting a fresh session under different light. Registered both methods
in `CameraCapturePlugin.m`; no new files, so no further `project.pbxproj`
edits needed.

Extended the JS wrapper and the `App.tsx` test harness with lock/unlock
buttons and a filmstrip of every captured frame (was a single
overwritten photo before) — specifically so 1.3's acceptance criteria
(10 consecutive frames, visually compared for flicker) is actually
checkable by hand once this runs on a device.

Same caveat as 1.1/1.2: `tsc`/`vite build`/`cap sync` pass, but the Swift
has never compiled — no Xcode/device access here. All three tasks in
phase 1 are code-complete and marked `in_progress`, waiting on one
physical-device session to open the project, run it, and do the actual
lock → capture 10 frames → play back at 12fps → look for flicker check.
That result is the gate RUMBO.md describes: if it flickers, phase 1
needs rethinking before anything in phase 2 starts.

---

### 2026-08-16 (later) — Task 1.2: native camera plugin skeleton written

Wrote the custom Capacitor plugin from task 1.2: `CameraCapturePlugin.swift`
wraps AVFoundation directly (own `AVCaptureSession` + `AVCapturePhotoOutput`,
requests camera permission, lazily configures the session on first call),
registered the classic way with a `CameraCapturePlugin.m` bridge file using
the `CAP_PLUGIN`/`CAP_PLUGIN_METHOD` macros — chosen over the newer
`CAPBridgedPlugin` self-registration protocol because it's the
better-documented, lower-risk path when there's no way to build and test
locally in this environment. Added both files to `App.xcodeproj/project.pbxproj`
by hand (file references + Sources build phase entries) since the project
uses classic explicit file references, not Xcode 16's file-system-synced
groups — new files on disk wouldn't otherwise get compiled. Added
`NSCameraUsageDescription` to `Info.plist`, without which the app would
crash on first camera access instead of prompting.

On the JS side: `src/native/cameraCapture.ts` wraps it with
`registerPlugin`, and `App.tsx` got a temporary manual test harness (a
"Capture photo" button that renders the returned image) — not the real
capture UI, just enough surface to verify 1.2's acceptance criteria by
hand. `capturePhoto()` still takes one auto-exposed photo with no
frame-to-frame lock; that's exactly task 1.3, the one that decides if the
project's technical bet pays off.

**Everything here is unverified beyond `tsc`/`vite build`/`cap sync`** —
this environment has no macOS/Xcode, so the Swift half of this has never
actually compiled. Marked both 1.1 and 1.2 `in_progress` in `tasks.json`
rather than `pending` (code exists) or a false `done` (hardware
verification, which each task's own acceptance criteria requires, hasn't
happened). Opening `ios/App/App.xcodeproj` in Xcode (no `.xcworkspace` — this
project uses Swift Package Manager, not CocoaPods) and running on a
physical device is the real next step before touching 1.3.

---

### 2026-08-16 — Project switched to English; task 1.1 scaffold done

The owner decided the whole project — code, docs, commits, everything —
goes in English from here on, breaking with Draw/Beautyapp's
Spanish-language convention. `CLAUDE.md`, `RUMBO.md`, `checkpoint.md`, and
`tasks.json` were rewritten in English (content unchanged, translation
only).

Also completed task 1.1 from `tasks.json`: the Capacitor scaffold. React
19.2.8 + Vite 8.2.1 + Zustand 5.0.15 + TypeScript, wired up with the
`core/`/`gl/`/`state/`/`ui/` folder layout the rest of the engine will
grow into (only `src/main.tsx` and `src/ui/App.tsx` exist so far — a
blank shell, nothing to render yet). `npm run build` and `npm run lint`
both pass clean. Added the iOS platform via `npx cap add ios` (Capacitor
8.5, Swift Package Manager — no CocoaPods) and ran `npx cap sync ios`
successfully, matching task 1.1's verify_command.

**One deviation from the blueprint, made on the spot**: `typescript` is
pinned to `~6.0.3` instead of the just-released `7.0.2`. Checked
`typescript-eslint`'s registry listing — its peer range still caps at
`typescript <6.1.0`, so installing TS7 would have broken `npm run lint`
outright. Noted here so nobody re-bumps to "latest" without checking
`typescript-eslint` support first; revisit once it publishes a TS7-compatible
release.

Not yet done, still open from task 1.1: opening `npx cap open ios` and
confirming the blank screen builds and runs on a physical device — no
Xcode/device access from this environment. That verification is next,
on hardware, before starting 1.2 (the native camera plugin).

---

### 2026-08-15 (later) — Brushes and palettes: direct port from Trace, not a redesign

The owner specifically asked whether Clumsyloop would reuse Trace's
brushes and color palettes, given how far along that work already was.
The answer was yes, but the original blueprint only implied it inside
"port the `core/` pattern" — without naming `brush.ts` (20 presets, 5
categories) or the palette system in `state/store.ts` as explicit pieces.
Fixed in `CLAUDE.md` and `RUMBO.md`: these two pieces are a direct port,
without the adaptation the rest of the engine needs (camera,
monetization), precisely because they have nothing to do with either.
Beautyapp is already precedent that `brush.ts` ports well to another
project.

---

### 2026-08-15 — Project born: architecture and name, no code yet

Came up while comparing the owner's existing project catalog (Dimel,
Trace, Beautyapp, SkySimAcademy, Draw) to evaluate which had the most
commercial runway, and from there to a specific question: is a new
animation project worth building, based on Trace's architecture, but
designed to monetize from day one instead of staying free and local like
Trace?

**Market research came before code.** It was verified — not assumed —
that Stop Motion Studio dominates the pure stop-motion niche (~2000
reviews, 4.5★, over a decade in the market): competing head-on there is a
losing race. The differentiating angle was found by checking what
Procreate Dreams, the professional animation tool of reference, does: it
exports video or a raw image sequence, but not even they built their own
feed — the raw sequence is explicitly meant for professional pipelines,
not for sharing. That was the fact that closed the decision: drawing +
camera on the same timeline, with an `.mp4`-only feed, is an angle nobody
in this market is serving.

**Ran the `architect` skill** (with the `questions/`/`knowledge/`
reference folders unavailable in this environment — the process was put
together with the same rigor from first principles: interview, a
confirmation gate, no code before decisions closed) to turn the idea into
concrete architecture. Decisions closed, in order: Capacitor (not a PWA —
the camera needs native exposure/focus control the web doesn't give, and
the audience arrives via App Store search, not by installing a PWA) →
Firebase (not Supabase — for push notification maturity, thinking about a
future Android version) → social feed with publishable clips → manual
moderation for v1 (report + takedown within 24h, the minimum Apple
requires for UGC) → iOS-only for launch. Full detail with the reasoning
for each is in `RUMBO.md`.

**The name took longer than the architecture.** Several discarded
rounds: "MotionLobby"/"MotionLair" (sound like a work tool, not something
a 16-20 year-old wants next to TikTok), "Squish"/"Clayo"/"Framey"/"Wiggle"
(already existed), "Nudge"/"Sprocket"/"Blorp"/"Glob" (confirmed clashes
via search), "Blobbymotion"/"Blobby" alone (the "blob" territory is
saturated — three published apps use just that word), "Sweesh" (dropped
for phonetic closeness to "Swoosh," Nike's registered trademark — a real
legal risk, not just an aesthetic one), "Clumsy" alone (saturated: eight
different apps use it as a standalone word for casual games). Landed on
**Clumsyloop** — a compound with no clashes, and the only one that says
something about the product (handmade imperfection is the charm) instead
of just describing it.

Created the `tommyelgucci/Clumsy` repository (empty) and wrote the three
starting documents (`CLAUDE.md`, `RUMBO.md`, this file). The real next
step, flagged in `RUMBO.md`, is prototyping the native camera plugin over
AVFoundation — it's the technical risk that could sink the whole project,
so it comes before any screen.
