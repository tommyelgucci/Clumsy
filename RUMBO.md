# RUMBO — Where Clumsyloop is headed and why in this order

This document is strategy, not a concrete feature. It explains the
decisions already made, the build order, and what was deliberately left
open.

## The differentiator

**Correction (2026-09-11): this section previously staked the whole
product on beating Stop Motion Studio for a TikTok/Reels-only, vertical-
video audience. That framing was wrong from the start — an assumption an
earlier session introduced, never verified, and then this session kept
building on top of, including at least one feature explicitly rejected
because it "didn't match the product's identity" (see known debts below;
that rejection no longer holds). Corrected here.**

The real competitive set for iPad/mobile 2D animation is Procreate
Dreams, ToonSquid, Clip Studio Paint, Callipeg, and RoughAnimator — not
just Stop Motion Studio. Each already does part of the job well:

- **Procreate Dreams** — the reference professional tool, but (per the
  owner's own comparison, 2026-09-11) still weak on lasso/shape
  selection, deform tools, and has a layer system that gets complex fast.
- **ToonSquid** — frame-by-frame *and* keyframe animation, rigging,
  animated text, vector layers, lasso selection. One-time purchase (~$9.99).
- **Clip Studio Paint** — the actual industry standard for anime/manga:
  the most mature brush engine, layer management, onion skinning, and
  timeline tools of the group. Subscription/upgrade-pass priced —
  and famously not simple to learn.
- **Callipeg** — built specifically for hand-drawn frame-by-frame work,
  with the most intuitive timing/onion-skinning controls of the set.
- **RoughAnimator** — lightweight and technical: per-frame FPS control,
  precise audio import for lip-sync, clean export to desktop tools
  (Toon Boom, Animate). One-time purchase (~$4.99).

None of them does camera capture on the same timeline as drawing at all
— verified, not assumed: Procreate Dreams exports video or a raw image
sequence explicitly meant for an external compositor (After Effects), not
for shooting stop-motion frames through the app itself, and the other
four are pure drawing/animation tools with no camera input whatsoever.
**That gap — real camera capture as one more source of frames on the
same timeline as drawing — is still the one thing only Clumsyloop does.**
But it's not the whole pitch anymore: the pitch is being **easier to
pick up than any of the five above** while covering their individual
strengths (onion skinning, keyframe/rig animation, lasso/shape selection,
audio + lip-sync timing, adjustable FPS, a real brush/layer engine) —
not a narrower "stop motion for TikTok" tool that happens to also draw.

**Consequence for the feed**: publish `.mp4`. Whether the raw frame
sequence is also worth exposing as a power-user export (matching
RoughAnimator's clean desktop-tool export, or Procreate Dreams' own raw
sequence output) is now an open question again, not settled — revisit
once the feed itself is closer to being built (phase 4).

## Platform decisions, in the order they were closed

**1. Capacitor, not a pure PWA.** Trace and Beautyapp are PWAs because
they need neither precision camera control nor aggressive monetization.
This project needs both at once:
- **Camera**: the browser's `getUserMedia` doesn't give fine-grained
  exposure/focus control — for stop motion that matters, it's the one
  thing that sets Clumsyloop apart from every other tool in its
  competitive set (see "The differentiator"), even though it's no
  longer the sole reason the app exists.
- **Discovery and billing**: animators and content creators find tools
  by searching the App Store, not by installing a PWA from Safari — true
  whether they're cutting a TikTok, a YouTube short, or a personal
  animation project. And a subscription sold inside the app needs
  StoreKit — Apple requires IAP for digital content, going straight to
  Stripe risks rejection in review.

The cost (US$99/year developer membership, ~15-30% Apple commission) is
cheap compared to losing either of those two things.

**2. Firebase, not Supabase.** The initial recommendation was Supabase
(real Postgres, no vendor lock-in, and already familiar since Dimel uses
Postgres). Firebase won out for the maturity of its push notification
integration, specifically with a future Android version in mind — even
though v1 is iOS-only, so that particular advantage isn't cashed in yet.
Noted here so the argument doesn't need repeating if someone asks "why
not Supabase?" in six months: the reason isn't price or the data model,
it's future push notifications.

**3. iOS-only for launch.** Capacitor shares most of the code between
iOS and Android, but every extra platform is more testing surface — and
the native camera plugin (see below) has to be built twice if launched
on both. One well-solved market before duplicating the work.

**4. Manual moderation in v1.** Apple requires report + block + takedown
within 24h for any app with user content — that's non-negotiable, it's
in scope from day one. What got deferred is **automated** moderation (a
Cloud Vision-style API): without real traffic there's nothing to
calibrate it against, and building it before the first real report is
solving a problem that doesn't exist yet.

**5. Brushes and palettes port from Trace as-is, not redesigned.**
`core/brush.ts` (20 presets across 5 categories: sketch, ink, paint,
texture, eraser — with stamp generation and the One Euro filter) and the
palette system in `state/store.ts` (fixed `PaletteGroup`s + user
`UserPalette`) are already polished and production-tested. Beautyapp
already validated that `brush.ts` ports well to another project — its
retouch `StrokeBuilder` is built on that same base. Rebuilding them from
scratch for Clumsyloop would throw away finished work for no gain:
unlike the rest of the engine, these two pieces have nothing to do with
the camera or monetization, so they don't need the adaptation
`document.ts`/`engine.ts` do.

## The technical risk that goes first

**Correction (2026-09-11): this section used to say the camera plugin's
success or failure decides whether "the rest of the plan matters" —
wrong, downstream of the same corrected assumption above. It's still a
real, hard risk worth resolving early; it just isn't a single point of
failure for the whole product anymore.**

**The native camera plugin is still a genuine technical risk, just not
an existential one.** Capacitor's stock plugin only takes a single photo;
stop motion needs to lock exposure, focus, and white balance frame to
frame — if this isn't solved well, every photo re-exposes on its own and
the final sequence flickers, which is exactly the problem a serious
stop-motion tool can't have. Worth prototyping early precisely because
it's hard to de-risk any other way (no shortcut but building it and
testing on a device) — but if it turns out AVFoundation can't hit the
necessary fidelity, Clumsyloop still ships as a complete 2D animation
app without stop-motion capture, same scope as ToonSquid/Callipeg/
RoughAnimator (none of which have a camera feature at all). That's a
real loss of one differentiator, not a dead project.

## Build phases

1. **Camera plugin prototype** (AVFoundation via Capacitor) — the real
   risk, validated first, on a physical device.
2. **Local capture + drawing engine**, no cloud — the product has to
   work fully offline before adding a backend.
3. **Firebase**: auth (Sign in with Apple) + entitlements + StoreKit
   receipt validation via Cloud Function.
4. **Feed**: publish, view, external sharing (native share sheet).
5. **Reporting and manual moderation** — an Apple requirement, can't be
   skipped to reach review sooner.
6. **Packaging and submission for Apple review.**

## Business model

Freemium: watermark and limited resolution on the free plan,
subscription for clean export, more layers, and cloud save. The cloud
isn't a luxury here — a stop-motion project is hundreds of photos, and
losing that work because the iPad ran out of space is the kind of
frustration that causes churn, not just a missing feature.

## The name

**Clumsyloop.** It came after several discarded rounds of names —
"motion"/"anima" as a prefix sounds like a work tool, not something a
16-20 year-old wants next to TikTok on their home screen; "blob"/"clumsy"
alone are saturated on the App Store (eight different apps use "Clumsy"
as a standalone word: Clumsy Ninja, Clumsy Cat, Clumsy Bomb, among
others); "sweesh" got dropped for its phonetic closeness to "Swoosh,"
Nike's registered mark — a real legal risk for a project with no legal
budget, even without an exact registered clash.

"Clumsyloop" survived the check (no app or trademark clash for the exact
compound) and is the only name from the whole round that **says
something about the product** instead of just describing it: "clumsy" is
exactly the charm of handmade animation — nothing stays perfect, and
that's what makes it shareable instead of studio animation — and "loop"
is literally what the app produces.

## Known debts / risks left open

- **Manual moderation doesn't scale.** The day there's real traffic, a
  single internal panel reviewed by hand will fall short. Not a v1
  problem, but worth not forgetting — see the phases section, point 5.
- **No Android from day one** means no access to that market until it's
  decided to open it — a business decision, not a technical one,
  determines when.
- **The native camera plugin is the project's biggest bet** and hasn't
  been prototyped yet. Everything else in this document assumes it
  works; if it doesn't hit the necessary fidelity, this plan needs
  revisiting starting from phase 1.
- **UPNG.js (MIT) is the library to reach for once local persistence
  (task 2.5) or a raw-sequence power-user export gets built** — PNG/APNG
  encoding that fits the format Trace's `io.ts` pattern already expects.
  Evaluated against three other permissively-licensed repos on
  2026-08-16 (open-brush, Apache-2.0, and ccapture.js, MIT) while
  looking for inspiration; the other two didn't yield anything concrete
  for this project — open-brush is Unity/C# 3D and Clumsyloop's brush
  system is already a direct port from Trace, and ccapture.js's actual
  encoders target browser canvas capture, not the AVFoundation export
  path this project uses.
- **Motion blur between stop-motion frames is a plausible v2+ feature**,
  not scoped for v1 and not yet a task — noted here so it isn't lost.
  ccapture.js's technique (GPU-side accumulation across sub-frames,
  WebGL2 `EXT_color_buffer_float`) is the concrete approach to reach for
  if this ever gets built.
- **An audio track + timeline scrubbing (for lip-sync/dialogue timing)
  was requested alongside the bucket fill tool (2026-09-10) but rejected
  as "a mismatch with the product's identity" — that rejection no longer
  holds (2026-09-11 correction) and is retracted, not just softened.**
  RoughAnimator's own standout feature is exactly this: precise audio
  import for lip-sync timing. Now that Clumsyloop's actual bar includes
  RoughAnimator, this isn't a scope mismatch, it's part of the job. Still
  genuinely blocked on the same structural gap named at the time — there
  is no multi-frame timeline UI yet for a playhead to scrub across, and
  `document.ts` cut `AudioTrack` pending that — but it's back on the
  table as real, wanted scope, not something to revisit only if the
  owner changes their mind. Belongs with task 2.3's timeline work.
- **Onion skinning, keyframe/rig-based animation, and lasso/shape
  selection are all real gaps against the corrected competitive bar**
  (Callipeg's onion skinning, ToonSquid's rigging/keyframes and lasso
  selection) **and none of them are built or itemized as tasks yet.**
  Noted here so they aren't lost; each needs its own scoping pass before
  becoming a task — onion skinning is probably the smallest lift (a
  ghosted read of the adjacent cel already exists conceptually in
  `celAt`/`celStartFrame`, just needs a render path), rigging is
  probably the largest (Trace's own `document.ts` cut skeletons/`rig.ts`
  entirely, so there's no port to lean on — see task 2.1's port notes).
- **Adjustable per-frame FPS (RoughAnimator's other standout feature) has
  no task yet either.** `ClumsyloopDocument.fps` already exists as a
  single document-wide value (see `core/document.ts`); per-frame hold
  duration is a bigger, unbuilt idea, closer to Callipeg/RoughAnimator's
  actual timing controls.
- **The document's default canvas size (`core/document.ts`'s
  `newDocument()`, currently `1080x1920`) is a direct casualty of the
  corrected TikTok-only assumption and is now known-wrong, not yet
  fixed.** The owner's call (2026-09-11): a format picker at project
  creation — vertical 9:16, horizontal 16:9, square 1:1, matching how
  Procreate/ToonSquid/Clip Studio Paint all handle it — not a single
  fixed default and not free-form custom sizing. Not yet built; until it
  is, `DrawingCanvas.tsx`'s `DOC_WIDTH`/`DOC_HEIGHT` test constants
  (360x640, the same 9:16 ratio) and the new responsive canvas layout
  (task 2.12) were both built and verified against 9:16 only — the
  layout's own object-fit-based sizing should hold for other aspect
  ratios unchanged, but that's not verified yet, only reasoned.
- **Pigment-mix blending (`BrushPreset.pigmentMix`, only the Watercolor
  preset sets it) is still not implemented**, even after task 2.10 added
  the wet-stroke staging surface that a real implementation would merge
  through. `gl/shaders.ts` deliberately left out `MIX_FS` back at task 2.2
  for the same reason: without Trace's own shader source available in
  this environment to port from, its actual blend math would have to be
  invented from scratch rather than ported, which is a different, riskier
  piece of work than the staging plumbing task 2.10 built. Today's stroke
  merge is plain `drawOver` regardless of `pigmentMix`, so Watercolor
  currently behaves like any other brush. Revisit once there's either a
  reference implementation to port or the owner explicitly wants a
  from-scratch design for it.
