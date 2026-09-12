# CLAUDE.md

Context for agents working in this repository. Read it before touching code.

## Repository state

The scaffold (React + TypeScript + Vite + Zustand, wrapped in Capacitor,
iOS platform) is in place — see `checkpoint.md` for exactly what's built
and verified so far, and `tasks.json` for what's still pending. The real
next step is in `RUMBO.md`, "Build phases", and **it starts with the
technical risk**, not the easy part.

## What Clumsyloop is

**Correction (2026-09-11): this section previously said Clumsyloop was a
short-form, TikTok/Reels-only, vertical-video app with drawing as a
bolt-on to stop-motion. That was wrong — an assumption an earlier session
introduced and never should have carried forward as fact. It shaped real
decisions (the document's default canvas size, task priorities, at least
one feature explicitly rejected for "not matching the product's
identity") that this correction now reopens. See `RUMBO.md`'s
differentiator section and known-debts list for what's affected.**

General-purpose 2D animation app, not a short-form-only tool: frame-by-
frame drawn animation, with camera capture (stop motion / claymation) as
**one input source among several** on the same timeline, not the reason
the app exists. Usable for TikTok/Reels clips, YouTube cartoons,
traditional hand-drawn animation, motion graphics, and easier stop-motion
— whatever the project calls for. Ships as an iOS/iPadOS app (see
`RUMBO.md`'s platform section — that distribution decision is separate
from this correction and unchanged); the web build used for local
development also renders responsively on iPad and desktop browser
widths, since that's the easiest way to preview UI work without opening
Xcode, not because desktop is a shipping target.

The bar is the real competitive set for iPad/mobile 2D animation, not
just Stop Motion Studio: Procreate Dreams, ToonSquid, Clip Studio Paint,
Callipeg, RoughAnimator. Clumsyloop's job is to be **easier to pick up
than any of them** while covering what they're each individually good
at — onion skinning, keyframe/rig-based animation, lasso/shape selection,
audio import with lip-sync timing, adjustable per-frame FPS, a real
brush/layer engine — plus one thing none of them do at all: camera
capture live on the same timeline as drawing. See `RUMBO.md` for the
full competitive reasoning and what's still missing to close that gap.

Technical engine based on the same pattern as **Trace** (another project
from the same owner: 2D drawing/animation in WebGL2) — not the same code,
the same layered architecture (`core/` pure, no DOM; `gl/` as the sole
point of contact with WebGL; `state/` with Zustand; `ui/` with React).
Port from there as a design reference, don't copy files unadapted: Trace
has no camera and no monetization, this project has both.

**Explicit exception — two pieces are ported directly, without
redesigning:** `core/brush.ts` (20 brushes across 5 categories, stamp
generation, One Euro filter) and the palette system from `state/store.ts`
(`PaletteGroup` + `UserPalette`). Both are already polished and
battle-tested — Beautyapp already proved `brush.ts` ports well to another
project (its retouch `StrokeBuilder` comes from that same base). Neither
has anything to do with the camera or monetization, so they don't need
the adaptation the rest of the engine does.

## Where to start

| Want to know… | Read |
|---|---|
| Where the product is headed and why these decisions in this order | `RUMBO.md` |
| What was done and when | `checkpoint.md` — newest entries **on top** |

## Commands

```bash
npm run dev              # Vite dev server, to iterate on the UI without opening Xcode
npm run build             # tsc -b && vite build
npm run lint               # eslint, must come back with no warnings
npx cap sync ios           # copies the web build into the native iOS project
npx cap open ios           # opens Xcode to build/run on simulator or device
```

**The iOS simulator can't test the camera.** Anything touching frame
capture (exposure, focus, the native plugin) gets tested on a physical
device — the simulator has no real camera and AVFoundation behavior isn't
equivalent.

## How commits are signed

Same convention as the rest of this owner's repositories:

```bash
git config user.name  "tommyelgucci"
git config user.email "299895314+tommyelgucci@users.noreply.github.com"
git config commit.gpgsign false
```

No `Co-Authored-By: Claude`, no `Claude-Session:`, no `claude.ai/code`
link in the commit body. `commit.gpgsign false` isn't optional — without
it the commit lands under the owner's name but signed with a sandbox key,
and GitHub flags it `unknown_key`.

## Language

**Everything in English** — code, comments, UI copy, commit messages,
and documentation (`CLAUDE.md`, `RUMBO.md`, `checkpoint.md`,
`tasks.json`). This is a deliberate departure from Draw/Beautyapp, which
write in Spanish — the owner's explicit call for this project. Don't
introduce Spanish strings, comments, or docs going forward.

## Architecture conventions

**All color is alpha-premultiplied** in textures, shaders, and buffers
read with `readPixels` — same invariant as Trace and Beautyapp, carried
over on purpose because breaking it produces subtle visual glitches
(color halos, dark edges).

**The document is a mutable object, not React state.** Same
`engine.touch()` → bumps `revision` → a `useEngineRevision()` hook forces
a re-render pattern. Putting the document (frames, layers) into React
state would duplicate megabytes on every capture.

**Camera capture needs a custom native plugin**, not Capacitor's stock
one (`@capacitor/camera`, which only takes a single photo via
`UIImagePickerController`). Stop motion needs to lock exposure, focus,
and white balance **across** frames — if every photo re-exposes on its
own, the sequence flickers. This wraps AVFoundation directly. It's the
project's biggest technical risk — see `RUMBO.md`.

**Verify on a real device, not just the compiler.** Same as Trace and
Beautyapp: `tsc` doesn't see a broken WebGL pipeline or a native plugin
that compiles but fails to actually lock focus.

## Backend

- **Firebase**: Auth (Sign in with Apple as the primary method),
  Firestore (`clips` collection for the feed, chronological, no
  algorithm), Storage (published `.mp4`s).
- **Payments**: StoreKit 2 client-side. Subscription entitlement is
  **never trusted from the client** — a Cloud Function validates the
  receipt against the App Store Server API and only then writes the
  state to Firestore.
- **External sharing**: iOS native share sheet to
  Instagram/TikTok/X/Threads/Facebook, not per-platform API integration
  — avoids depending on third-party approvals we don't control.

## v1 scope

**Includes**: capture + drawing on the same timeline, clean paid export
(watermark on the free plan), own `.mp4` feed, external sharing, content
reporting + manual takedown, StoreKit subscription.

**Deliberately excludes** (not debt, scope): Android, comments,
followers, algorithmic feed, automated moderation, direct messages.
Don't add any of these without the owner asking — each one changes
Apple's compliance profile (especially moderation) or the infrastructure
footprint.

## Apple compliance for user-generated content

The public feed **requires**: content reporting, blocking abusive users,
and the team's ability to take down reported content within 24 hours.
Without this, Apple rejects the app in review — it's not an optional
nicety, it's a guideline requirement for any app with UGC. v1 handles it
manually (report → Cloud Function hides the clip → a minimal internal
panel), not with automated moderation — see `RUMBO.md` for why in that
order.
