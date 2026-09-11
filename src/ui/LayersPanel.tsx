import { useEffect, useState } from 'react';
import type { Engine } from '../gl/engine';
import { ChevronDownIcon, ChevronUpIcon, EyeIcon, EyeOffIcon, LockIcon, PlusIcon, TrashIcon, UnlockIcon } from './icons';

/**
 * Layer list: add/delete/reorder/rename, visibility and lock toggles, and
 * picking which layer strokes/fills write into. Only ever mounted once
 * `DrawingCanvas` already has an `Engine` instance (see its `ready` gate),
 * so — unlike that component's own Undo/Redo subscription — there's no
 * first-mount ordering hazard here: the engine already exists by the time
 * this component's first effect runs, so a plain `useEffect` subscription
 * to `engine.subscribe()` is safe.
 *
 * Visual pass (task 2.11): icon buttons instead of text buttons, but
 * every button keeps the same `aria-label` it had before — the icons are
 * decorative (`aria-hidden`), so accessible names, and anything that
 * looks them up (Playwright's scripts/layers-smoke.mjs included), are
 * unaffected by this restyle.
 */
export function LayersPanel({ engine }: { engine: Engine }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => engine.subscribe(() => forceUpdate((v) => v + 1)), [engine]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const commitRename = () => {
    if (renamingId) engine.renameLayer(renamingId, renameValue);
    setRenamingId(null);
  };

  // doc.layers is bottom-to-top (see core/document.ts); every layer-based
  // drawing tool shows the stack top-to-bottom in its panel instead, so
  // that's reversed here for display only.
  const layersTopToBottom = [...engine.doc.layers].reverse();

  return (
    <div className="cl-section">
      <div className="cl-section-header">
        <h3 className="cl-section-title">Layers</h3>
        <button className="cl-add-layer" onClick={() => engine.addLayer()}>
          <PlusIcon size={14} />
          Add layer
        </button>
      </div>
      <ul className="cl-layer-list">
        {layersTopToBottom.map((layer) => {
          const isActive = layer.id === engine.activeLayerId;
          return (
            <li
              key={layer.id}
              className={`cl-layer-row${isActive ? ' cl-layer-row--active' : ''}`}
              onClick={() => {
                if (!isActive) engine.setActiveLayer(layer.id);
              }}
            >
              <button
                className={`cl-layer-btn${layer.visible ? '' : ' cl-layer-btn--active'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  engine.setLayerVisible(layer.id, !layer.visible);
                }}
                aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}
              >
                {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
              </button>
              <button
                className={`cl-layer-btn${layer.locked ? ' cl-layer-btn--active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  engine.setLayerLocked(layer.id, !layer.locked);
                }}
                aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`}
              >
                {layer.locked ? <LockIcon /> : <UnlockIcon />}
              </button>
              {renamingId === layer.id ? (
                <input
                  className="cl-layer-input"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <span
                  className="cl-layer-name"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(layer.id);
                    setRenameValue(layer.name);
                  }}
                >
                  {layer.name}
                  {layer.kind === 'camera' ? <span className="cl-layer-kind"> (camera)</span> : ''}
                </span>
              )}
              <button
                className="cl-layer-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  engine.moveLayer(layer.id, 'up');
                }}
                aria-label={`Move ${layer.name} up`}
              >
                <ChevronUpIcon />
              </button>
              <button
                className="cl-layer-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  engine.moveLayer(layer.id, 'down');
                }}
                aria-label={`Move ${layer.name} down`}
              >
                <ChevronDownIcon />
              </button>
              <button
                className="cl-layer-btn cl-layer-btn--danger"
                onClick={(e) => {
                  e.stopPropagation();
                  engine.removeLayer(layer.id);
                }}
                disabled={engine.doc.layers.length <= 1}
                aria-label={`Delete ${layer.name}`}
              >
                <TrashIcon />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
