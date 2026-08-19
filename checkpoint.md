# Checkpoint — Progress log

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
