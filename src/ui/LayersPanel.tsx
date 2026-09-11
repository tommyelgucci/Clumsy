import { useEffect, useState } from 'react';
import type { Engine } from '../gl/engine';

/**
 * Layer list: add/delete/reorder/rename, visibility and lock toggles, and
 * picking which layer strokes/fills write into. Only ever mounted once
 * `DrawingCanvas` already has an `Engine` instance (see its `ready` gate),
 * so — unlike that component's own Undo/Redo subscription — there's no
 * first-mount ordering hazard here: the engine already exists by the time
 * this component's first effect runs, so a plain `useEffect` subscription
 * to `engine.subscribe()` is safe.
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
    <div>
      <h3>Layers</h3>
      <button onClick={() => engine.addLayer()}>Add layer</button>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {layersTopToBottom.map((layer) => {
          const isActive = layer.id === engine.activeLayerId;
          return (
            <li
              key={layer.id}
              onClick={() => {
                if (!isActive) engine.setActiveLayer(layer.id);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 4px',
                background: isActive ? '#345' : 'transparent',
                color: isActive ? '#fff' : undefined,
                cursor: 'pointer',
              }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  engine.setLayerVisible(layer.id, !layer.visible);
                }}
                aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}
              >
                {layer.visible ? 'Hide' : 'Show'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  engine.setLayerLocked(layer.id, !layer.locked);
                }}
                aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`}
              >
                {layer.locked ? 'Unlock' : 'Lock'}
              </button>
              {renamingId === layer.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                />
              ) : (
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(layer.id);
                    setRenameValue(layer.name);
                  }}
                  style={{ flex: 1, fontWeight: isActive ? 'bold' : 'normal' }}
                >
                  {layer.name}
                  {layer.kind === 'camera' ? ' (camera)' : ''}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  engine.moveLayer(layer.id, 'up');
                }}
                aria-label={`Move ${layer.name} up`}
              >
                Up
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  engine.moveLayer(layer.id, 'down');
                }}
                aria-label={`Move ${layer.name} down`}
              >
                Down
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  engine.removeLayer(layer.id);
                }}
                disabled={engine.doc.layers.length <= 1}
                aria-label={`Delete ${layer.name}`}
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
