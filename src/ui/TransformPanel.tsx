import { useEffect, useRef, useState } from 'react';
import { EASING_LABELS, EASINGS, TRANSFORM_LABELS, TRANSFORM_PROPS, type Easing, type Keyframe, type TransformProp } from '../core/document';
import type { Engine } from '../gl/engine';
import { KeyframeIcon } from './icons';

const EASING_OPTIONS = Object.keys(EASINGS) as Easing[];

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/** Slider range/step per property, in the units the user sees — rotation
 *  is stored in radians internally (`mat3FromTRS`'s convention) but shown
 *  in degrees, since that's what every other drawing/animation app uses. */
const RANGES: Record<TransformProp, { min: number; max: number; step: number; toDisplay: (v: number) => number; toInternal: (v: number) => number }> = {
  x: { min: -400, max: 400, step: 1, toDisplay: (v) => v, toInternal: (v) => v },
  y: { min: -400, max: 400, step: 1, toDisplay: (v) => v, toInternal: (v) => v },
  scale: { min: 0.1, max: 3, step: 0.01, toDisplay: (v) => v, toInternal: (v) => v },
  rotation: { min: -180, max: 180, step: 1, toDisplay: (v) => v * RAD_TO_DEG, toInternal: (v) => v * DEG_TO_RAD },
  opacity: { min: 0, max: 1, step: 0.01, toDisplay: (v) => v, toInternal: (v) => v },
};

/**
 * Per-property row: a value slider plus a keyframe ("stopwatch") toggle,
 * for the active layer's `TransformTrack` (task 2.16). The channel model
 * itself (`core/document.ts`'s `Channel`/`Keyframe`, with easing) and the
 * renderer's sampling of it at the composited frame both already existed
 * since task 2.1 — nothing before this let a user actually set one.
 *
 * Slider drags are grouped into a single undo step via
 * `Engine.snapshotLayerTransform`/`previewLayerTransformValue`/
 * `commitLayerTransform`: the native range input's onChange already fires
 * on every intermediate value during a drag (React's onChange for
 * range/text inputs is wired to the native `input` event, not `change`),
 * so pushing one history entry per onChange would mean one undo step per
 * pixel dragged. `dragStart` captures the channel's shape once, at the
 * first onChange since the last commit, and pointer-up/blur commit it —
 * the same begin/commit-a-whole-gesture idea as Beautyapp's own
 * `Slider.tsx` (`onBeginChange`/`onCommitChange`), reimplemented here
 * directly on native events rather than porting that component, since a
 * single row of sliders doesn't need its own custom-drawn control.
 *
 * Easing (task 2.18): a small `<select>` next to the stopwatch, shown
 * only when there's actually a keyframe at the current frame to attach
 * an easing choice to — changing it doesn't move the keyframe, just how
 * the animation approaches/leaves it (`core/document.ts`'s `EASINGS`,
 * already the renderer's own interpolation since task 2.1; every
 * keyframe just defaulted to `easeInOut` until now since nothing
 * exposed a way to change it).
 */
function TransformSlider({ engine, prop }: { engine: Engine; prop: TransformProp }) {
  const range = RANGES[prop];
  const dragStart = useRef<{ base: number; keys: Keyframe[] } | null>(null);

  const commit = () => {
    if (!dragStart.current) return;
    engine.commitLayerTransform(prop, dragStart.current);
    dragStart.current = null;
  };

  const value = engine.getLayerTransformValue(prop);
  const keyframed = engine.layerTransformIsKeyframed(prop);
  const hasKeyHere = engine.hasKeyframeAtCurrentFrame(prop);
  const easing = engine.getKeyframeEasing(prop);

  return (
    <div className="cl-slider-row">
      <div className="cl-section-header">
        <span>{TRANSFORM_LABELS[prop]}</span>
        <div className="cl-keyframe-controls">
          {hasKeyHere && easing && (
            <select
              className="cl-easing-select"
              value={easing}
              onChange={(e) => engine.setKeyframeEasing(prop, e.target.value as Easing)}
              aria-label={`${TRANSFORM_LABELS[prop]} easing`}
            >
              {EASING_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {EASING_LABELS[opt]}
                </option>
              ))}
            </select>
          )}
          <button
            className={`cl-railbtn cl-railbtn--ghost${keyframed ? ' is-active' : ''}`}
            onClick={() => engine.toggleKeyframeHere(prop)}
            aria-pressed={hasKeyHere}
            aria-label={`${hasKeyHere ? 'Remove' : 'Add'} ${TRANSFORM_LABELS[prop]} keyframe here`}
            title={keyframed ? 'Animated — click to add/remove a keyframe here' : 'Click to start animating this property'}
          >
            <KeyframeIcon size={12} filled={hasKeyHere} />
          </button>
        </div>
      </div>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={range.toDisplay(value)}
        onChange={(e) => {
          if (!dragStart.current) dragStart.current = engine.snapshotLayerTransform(prop);
          engine.previewLayerTransformValue(prop, range.toInternal(Number(e.target.value)));
        }}
        onPointerUp={commit}
        onBlur={commit}
      />
    </div>
  );
}

export function TransformPanel({ engine }: { engine: Engine }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => engine.subscribe(() => forceUpdate((v) => v + 1)), [engine]);

  return (
    <div className="cl-section">
      {TRANSFORM_PROPS.map((prop) => (
        <TransformSlider key={prop} engine={engine} prop={prop} />
      ))}
    </div>
  );
}
