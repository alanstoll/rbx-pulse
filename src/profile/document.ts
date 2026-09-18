/**
 * The composite profile document: the primary datastore's unwrapped data as the root,
 * with every supplemental datastore mounted at its configured path, plus the bindings
 * expressions see ($meta, $entry, $stores, constants). Shared by extract, derive and
 * `pulse eval` so the three always agree on what an expression is evaluated against.
 */
import type { DatastoreConfig, PulseConfig } from '../config/schema.js';
import { storeAlias } from '../config/schema.js';
import { unwrap } from '../envelope/index.js';

/** Open Cloud entry metadata for one component, as ISO strings. */
export interface EntryInfo {
  createTime: string | null;
  revisionCreateTime: string | null;
  observedAt: string | null;
}

/** One component's stored value and metadata. */
export interface StorePart {
  body: unknown;
  entry?: EntryInfo;
}

export interface ProfileDocument {
  /** Root document: the primary datastore's unwrapped data with supplemental stores mounted. */
  data: unknown;
  /** Bindings available as $meta, $entry, $stores and every constant. */
  bindings: Record<string, unknown>;
  /** Non-fatal problems, keyed for once-per-run reporting (e.g. `mount purchases`). */
  warnings: Record<string, string>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Place `value` at a dotted path in a copy of `root`, creating intermediate objects.
 * Only the objects along the path are copied, so the snapshot body is never mutated.
 * Returns the new root and whether something already existed at the path.
 */
export function mountAt(root: unknown, path: string, value: unknown): { root: Record<string, unknown>; collided: boolean } {
  const keys = path.split('.');
  const out: Record<string, unknown> = isObject(root) ? { ...root } : {};
  let cursor = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    const next = cursor[k];
    const copy: Record<string, unknown> = isObject(next) ? { ...next } : {};
    cursor[k] = copy;
    cursor = copy;
  }
  const leaf = keys[keys.length - 1]!;
  const collided = Object.prototype.hasOwnProperty.call(cursor, leaf) && cursor[leaf] !== undefined;
  cursor[leaf] = value;
  return { root: out, collided };
}

/**
 * Compose the document from the parts present. `parts` is keyed by datastore name;
 * stores with no part are simply absent (undefined at their mount and under $stores).
 */
export function composeDocument(config: Pick<PulseConfig, 'constants'> & { game: { datastores: DatastoreConfig[] } }, parts: Map<string, StorePart>): ProfileDocument {
  const primary = config.game.datastores[0]!;
  const stores: Record<string, { data: unknown; meta: Record<string, unknown>; entry: EntryInfo }> = {};
  const warnings: Record<string, string> = {};
  const empty: EntryInfo = { createTime: null, revisionCreateTime: null, observedAt: null };
  let rootData: unknown = {};
  let meta: Record<string, unknown> = {};
  let entry: EntryInfo = empty;
  const mounted: { ds: DatastoreConfig; data: unknown }[] = [];
  for (const ds of config.game.datastores) {
    const part = parts.get(ds.name);
    if (!part) continue;
    let u: { data: unknown; meta: Record<string, unknown> };
    try {
      u = unwrap(ds.envelope, part.body);
    } catch {
      u = { data: part.body, meta: {} };
    }
    stores[storeAlias(ds)] = { ...u, entry: part.entry ?? empty };
    if (ds === primary) {
      rootData = u.data;
      meta = u.meta;
      entry = part.entry ?? empty;
    } else if (ds.mount) {
      mounted.push({ ds, data: u.data });
    }
  }
  for (const m of mounted) {
    if (rootData !== undefined && rootData !== null && !isObject(rootData)) {
      warnings[`mount ${m.ds.mount}`] = `cannot mount ${m.ds.name}: the primary document is not an object`;
      continue;
    }
    const r = mountAt(rootData, m.ds.mount!, m.data);
    if (r.collided) warnings[`mount ${m.ds.mount}`] = `the primary record already has a value at "${m.ds.mount}"; the mounted ${m.ds.name} store replaced it`;
    rootData = r.root;
  }
  return { data: rootData, bindings: { ...config.constants, meta, entry, stores }, warnings };
}
