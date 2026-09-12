/**
 * IndexedDB backend for local project persistence (task 2.5) — the third
 * piece, after `core/io.ts` (pure JSON + PNG) and `gl/projectIO.ts` (GPU
 * glue). Lives here rather than a new top-level folder for one file;
 * same reasoning `palettes.ts` already established for this directory —
 * app data that persists locally, not just ephemeral UI toggles.
 *
 * Same backend Trace's `io.ts` uses (a single key-value object store),
 * picked over Capacitor's Filesystem plugin so this doesn't need a new
 * native dependency for v1 — see checkpoint.md for the tradeoff.
 *
 * Stores each project's cels as an array of `[celId, bytes]` pairs
 * rather than a `Map` directly: `Map` values are structured-cloneable in
 * IndexedDB on modern engines, but this can't be confirmed on an actual
 * WKWebView from this environment (see CLAUDE.md, no physical device),
 * so this sticks to a shape (plain arrays) IndexedDB has always
 * supported everywhere instead of assuming.
 */
import type { CapturedProject } from '../gl/projectIO';

const DB_NAME = 'clumsyloop';
const STORE = 'projects';

interface StoredProject {
  meta: CapturedProject['meta'];
  cels: [string, Uint8Array][];
  savedAt: number;
}

/** No `indexedDB` global under Node's test runner — same guard
 *  `palettes.ts` uses for `localStorage`. This file's real verification
 *  happens in a browser (`scripts/persistence-smoke.mjs`), not `npm test`. */
function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: StoredProject): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(key: string): Promise<StoredProject | undefined> {
  const db = await openDB();
  const result = await new Promise<StoredProject | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as StoredProject | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbKeys(): Promise<string[]> {
  const db = await openDB();
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return keys.map(String);
}

/** Overwrites the saved project at `id` — the only write this module
 *  offers, matching the acceptance criteria's "closed mid capture
 *  session and reopened" scenario: there's no partial/incremental save
 *  in v1, every save re-encodes the whole project (same as Trace's
 *  autosave). A no-op when `indexedDB` isn't available. */
export async function saveProject(id: string, project: CapturedProject): Promise<void> {
  if (!hasIndexedDB()) return;
  await idbPut(id, { meta: project.meta, cels: [...project.cels], savedAt: Date.now() });
}

export async function loadProject(id: string): Promise<CapturedProject | undefined> {
  if (!hasIndexedDB()) return undefined;
  const stored = await idbGet(id);
  if (!stored) return undefined;
  return { meta: stored.meta, cels: new Map(stored.cels) };
}

export async function deleteProject(id: string): Promise<void> {
  if (!hasIndexedDB()) return;
  await idbDelete(id);
}

export async function listProjectIds(): Promise<string[]> {
  if (!hasIndexedDB()) return [];
  return idbKeys();
}
