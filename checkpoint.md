# Checkpoint — Progress log

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
