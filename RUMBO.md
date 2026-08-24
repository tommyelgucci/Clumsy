# RUMBO — Where Clumsyloop is headed and why in this order

This document is strategy, not a concrete feature. It explains the
decisions already made, the build order, and what was deliberately left
open.

## The differentiator

Stop Motion Studio has dominated the stop-motion niche for over a decade
— ~2000 reviews at 4.5★ in the store listing that kicked off this
project, cross-platform, well monetized. Competing head-on as "another
stop-motion app, but easier" is a feature race against someone with a
ten-year head start polishing exactly that. That's not the plan.

**The angle is drawing + camera on the same timeline.** It was verified
— not assumed — that no serious competitor does this: Procreate Dreams,
the reference professional animation tool, exports video (`.mp4`/`.mov`)
or a raw image sequence (`.png`/`.jpg`/`.tiff`), but the raw sequence is
explicitly meant to go to an external compositor (After Effects), not to
be published. Not even Procreate Dreams built its own feed — it leans on
existing networks via the `#procreatedreams` hashtag. No tool in this
market treats "drawing over stop motion" as its core function. That gap
is the product.

**Direct consequence for the feed**: publish `.mp4` only. The raw photo
sequence could exist as a power-user export down the line, but it isn't
feed content — nobody in any corner of this market publishes a folder of
loose photos for someone else to watch.

## Platform decisions, in the order they were closed

**1. Capacitor, not a pure PWA.** Trace and Beautyapp are PWAs because
they need neither precision camera control nor aggressive monetization.
This project needs both at once:
- **Camera**: the browser's `getUserMedia` doesn't give fine-grained
  exposure/focus control — for stop motion that matters, it's literally
  the product's core mechanism.
- **Discovery and billing**: the audience (TikTok/Reels creators) finds
  tools by searching the App Store, not by installing a PWA from Safari.
  And a subscription sold inside the app needs StoreKit — Apple requires
  IAP for digital content, going straight to Stripe risks rejection in
  review.

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

**The native camera plugin isn't an implementation detail, it's the risk
that can sink the whole project.** Capacitor's stock plugin only takes a
single photo; stop motion needs to lock exposure, focus, and white
balance frame to frame — if this isn't solved well, every photo
re-exposes on its own and the final sequence flickers, which is exactly
the problem a serious stop-motion tool can't have. That's why the build
phases start there instead of with the easy part (the UI, the feed): if
the camera plugin can't hit the necessary fidelity, the rest of the plan
doesn't matter.

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

## RoughAnimator-inspired UX ideas (evaluated 2026-08-20)

The owner shared a video of RoughAnimator (a well-regarded traditional
frame-by-frame iPad app) plus a prompt written for **Trace**, not this
project — asking for a lasso-select transform tool, a draggable
hold-frame timeline, high-precision onion skinning, and unlimited layers
with independent per-layer duration and audio scrubbing. Worth writing
down here since RoughAnimator is a real competitor in the "pure drawing,
no camera" corner of this market (the same corner Procreate Dreams sits
in — see "The differentiator" above), so its UX choices are legitimate
reference material for Clumsyloop specifically, not just Trace.

Evaluated against what's already built or scoped:

- **Hold/exposure frames**: already the data model, no new work needed.
  `core/document.ts`'s `celAt`/`celStartFrame`/`celHoldLength` (task 2.1)
  already implement "a cel holds until the next one starts" — RoughAnimator's
  draggable timeline block is a UI affordance over data that already
  exists, not a new engine concept.
- **Onion skinning**: built ahead of task 2.3 (the same "advance what
  doesn't depend on the camera" reasoning already used for 2.1/2.2) —
  `Renderer.renderOnionSkin` in `gl/renderer.ts` composites tinted ghost
  frames from before/after the current one, with adjustable opacity.
  First pass only, on purpose: every ghost gets the same opacity, no
  falloff by distance — a real timeline UI (task 2.3, still blocked on
  camera verification) is what would expose per-frame-distance control,
  not a WebGL constraint.
- **Lasso selection + interactive transform** (scale/rotate/translate/
  squash-stretch on a selection, applied live with the pencil): genuinely
  useful, but a bigger scope than a single follow-up — needs a selection
  mask/region type in `core/`, a GL warp pass, and pointer-driven UI, none
  of which exist yet. Not attempted here; worth its own task(s) once
  someone wants to scope it deliberately, not folded into an unrelated
  session.
- **Audio track import + scrubbing**: **conflicts with an explicit,
  already-documented v1 scope decision**, not just an open feature.
  `core/document.ts`'s header comment lists `AudioTrack` among what Trace
  has that Clumsyloop's `ClumsyloopDocument` deliberately dropped for v1.
  Reversing that needs the owner to say so explicitly — implementing it
  quietly here would contradict a decision that's already written down
  and was made on purpose.
- **Independent per-layer frame duration** (vs. this project's single
  `ClumsyloopDocument.frameCount` shared by every layer): a real
  architecture change, not an additive feature — every place that reads
  `doc.frameCount` today would need to decide what "per-layer" means for
  it. Flagged, not decided; needs its own conversation before code.

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
