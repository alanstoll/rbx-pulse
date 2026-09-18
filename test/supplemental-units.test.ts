/**
 * Supplemental datastores, unit level: mounting, the primary-required assembly rule,
 * the $default helper, config validation, and the demo's sparse purchase store.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeVersions } from '../src/profile/assemble.js';
import { composeDocument, mountAt } from '../src/profile/document.js';
import { eventRows, extractFacts } from '../src/profile/extract.js';
import { evaluate } from '../src/expr/engine.js';
import { ConfigError, loadConfig } from '../src/config/load.js';
import { datastoreSchema, discoveryOf, factSchema, storeAlias } from '../src/config/schema.js';
import { generateDataset, generatePurchases, tickPurchases, type DemoPurchase } from '../src/demo/generate.js';

const d = (s: string) => new Date(s);
const ds = (o: Record<string, unknown>) => datastoreSchema.parse(o);

describe('mountAt', () => {
  it('places a value at a dotted path without mutating the original', () => {
    const root = { a: { b: 1 }, keep: [1] };
    const r = mountAt(root, 'a.c.d', 'x');
    expect(r.root).toEqual({ a: { b: 1, c: { d: 'x' } }, keep: [1] });
    expect(r.collided).toBe(false);
    expect(root).toEqual({ a: { b: 1 }, keep: [1] });
  });
  it('reports a collision when something already exists at the path', () => {
    expect(mountAt({ p: [1] }, 'p', [2]).collided).toBe(true);
    expect(mountAt({ p: null }, 'p', 1).collided).toBe(true);
    expect(mountAt({ p: undefined }, 'p', 1).collided).toBe(false);
    expect(mountAt(undefined, 'p', 1).root).toEqual({ p: 1 });
  });
});

describe('composeDocument', () => {
  const primary = ds({ name: 'PlayerData', keyTemplate: 'Player_{userId}', envelope: 'documentservice' });
  const purchases = ds({ name: 'Purchases', keyTemplate: '{userId}', mount: 'purchases' });
  const nested = ds({ name: 'Extras', keyTemplate: '{userId}', mount: 'extras.stats', alias: 'ex' });
  const config = { constants: { k: 1 }, game: { datastores: [primary, purchases, nested] } };
  const body = { data: { xp: 5, extras: { keep: true } }, documentServiceSchemaVersion: 0, lockTimestamp: 7 };
  const entry = { createTime: '2026-01-01T00:00:00.000Z', revisionCreateTime: '2026-02-01T00:00:00.000Z', observedAt: '2026-02-02T00:00:00.000Z' };

  it('mounts supplemental stores into the root and exposes them under $stores with entry metadata', () => {
    const list = [{ at: 1, productKey: 'a' }];
    const doc = composeDocument(config, new Map([
      ['PlayerData', { body, entry }],
      ['Purchases', { body: list, entry: { ...entry, revisionCreateTime: '2026-03-01T00:00:00.000Z' } }],
      ['Extras', { body: { n: 2 } }],
    ]));
    expect(doc.data).toEqual({ xp: 5, extras: { keep: true, stats: { n: 2 } }, purchases: list });
    const stores = doc.bindings.stores as Record<string, { data: unknown; entry: { revisionCreateTime: string | null } }>;
    expect(stores.purchases!.data).toBe(list);
    expect(stores.purchases!.entry.revisionCreateTime).toBe('2026-03-01T00:00:00.000Z');
    expect(stores.ex!.data).toEqual({ n: 2 });
    expect(stores.ex!.entry.revisionCreateTime).toBeNull();
    expect(stores.PlayerData!.data).toEqual({ xp: 5, extras: { keep: true } });
    expect(doc.bindings.meta).toEqual({ documentServiceSchemaVersion: 0, lockTimestamp: 7 });
    expect(doc.bindings.entry).toEqual(entry);
    expect(doc.bindings.k).toBe(1);
    expect(doc.warnings).toEqual({});
  });

  it('leaves absent stores undefined so expressions behave like a missing field', async () => {
    const doc = composeDocument(config, new Map([['PlayerData', { body, entry }]]));
    expect((doc.data as Record<string, unknown>).purchases).toBeUndefined();
    expect(await evaluate('$count(purchases)', doc.data, doc.bindings)).toBe(0);
    expect(await evaluate('$sum(purchases.robuxSpent)', doc.data, doc.bindings)).toBeUndefined();
    expect(await evaluate('$default($sum(purchases.robuxSpent), 0)', doc.data, doc.bindings)).toBe(0);
    expect(await evaluate('$count(purchases) > 0', doc.data, doc.bindings)).toBe(false);
    expect(await evaluate('$stores.purchases', doc.data, doc.bindings)).toBeUndefined();
  });

  it('a mounted store replaces an inline value and warns once per mount', () => {
    const doc = composeDocument(config, new Map([
      ['PlayerData', { body: { data: { purchases: ['stale'] }, documentServiceSchemaVersion: 0 } }],
      ['Purchases', { body: ['live'] }],
    ]));
    expect((doc.data as { purchases: unknown }).purchases).toEqual(['live']);
    expect(Object.keys(doc.warnings)).toEqual(['mount purchases']);
  });

  it('a version without the primary yields an empty root but still mounts', () => {
    const doc = composeDocument(config, new Map([['Purchases', { body: [1] }]]));
    expect(doc.data).toEqual({ purchases: [1] });
  });

  it('cannot mount onto a non-object primary document', () => {
    const cfg = { constants: {}, game: { datastores: [ds({ name: 'P', keyTemplate: '{userId}' }), purchases] } };
    const doc = composeDocument(cfg, new Map([['P', { body: [1, 2] }], ['Purchases', { body: [3] }]]));
    expect(doc.data).toEqual([1, 2]);
    expect(doc.warnings['mount purchases']).toMatch(/not an object/);
  });

  it('storeAlias and discoveryOf follow their defaults', () => {
    expect(storeAlias(primary)).toBe('PlayerData');
    expect(storeAlias(purchases)).toBe('purchases');
    expect(storeAlias(nested)).toBe('ex');
    expect(storeAlias(ds({ name: 'X', keyTemplate: '{userId}', mount: 'a.b' }))).toBe('b');
    expect(discoveryOf(primary, { sync: {} })).toBe('list');
    expect(discoveryOf(primary, { sync: { index: {} } })).toBe('index');
    expect(discoveryOf(ds({ name: 'X', keyTemplate: '{userId}', sync: { discovery: 'list' } }), { sync: { index: {} } })).toBe('list');
    expect(purchases.sync.backfill).toBe(true);
  });
});

describe('composeVersions with a primary', () => {
  it('starts at the first primary snapshot and carries earlier supplemental snapshots into it', () => {
    const v = composeVersions(
      [
        { id: 5, datastore: 'B', observedAt: d('2026-01-05'), revisionCreatedAt: d('2025-12-01') }, // purchase written before we ever saw the primary
        { id: 1, datastore: 'A', observedAt: d('2026-01-01'), revisionCreatedAt: d('2025-12-30') },
        { id: 2, datastore: 'A', observedAt: d('2026-01-08'), revisionCreatedAt: d('2026-01-07') },
      ],
      'A',
    );
    expect(v.map((x) => x.components)).toEqual([{ A: 1, B: 5 }, { A: 2, B: 5 }]);
    expect(v[0]!.validFrom).toEqual(d('2025-12-30'));
    expect(v[0]!.revisionCreatedAt).toEqual(d('2025-12-30'));
  });
  it('interleaves a later-synced supplemental snapshot at its write time', () => {
    const v = composeVersions(
      [
        { id: 1, datastore: 'A', observedAt: d('2026-01-01'), revisionCreatedAt: d('2025-12-30') },
        { id: 2, datastore: 'A', observedAt: d('2026-01-08'), revisionCreatedAt: d('2026-01-07') },
        { id: 9, datastore: 'B', observedAt: d('2026-01-20'), revisionCreatedAt: d('2026-01-03') }, // first sync of B, written between A's versions
      ],
      'A',
    );
    expect(v.map((x) => x.components)).toEqual([{ A: 1 }, { A: 1, B: 9 }, { A: 2, B: 9 }]);
    expect(v[1]!.validFrom).toEqual(d('2026-01-03'));
  });
  it('without a primary, behaves as before (any snapshot cuts a version)', () => {
    const v = composeVersions([{ id: 5, datastore: 'B', observedAt: d('2026-01-05'), revisionCreatedAt: null }, { id: 1, datastore: 'A', observedAt: d('2026-01-06'), revisionCreatedAt: null }]);
    expect(v.map((x) => x.components)).toEqual([{ B: 5 }, { A: 1, B: 5 }]);
  });
});

describe('$default helper', () => {
  it('returns the fallback only for missing or null', async () => {
    expect(await evaluate('$default(a, 0)', {})).toBe(0);
    expect(await evaluate('$default(a, 0)', { a: null })).toBe(0);
    expect(await evaluate('$default(a, 0)', { a: 5 })).toBe(5);
    expect(await evaluate('$default(a, 0)', { a: false })).toBe(false);
    expect(await evaluate('$default(a, "none")', { a: '' })).toBe('');
  });
});

describe('events with attrs', () => {
  it('keeps a non-empty attrs object and drops empty ones', () => {
    const rows = eventRows([{ type: 'purchase', data: 'a', ts: 10, attrs: { currency: 'coins', robux: 49 } }, { type: 'x', data: 'b', ts: 11, attrs: {} }, { type: 'y', ts: 12, attrs: 'nope' }], 'seconds');
    expect(rows.map((r) => r.attrs)).toEqual([{ currency: 'coins', robux: 49 }, null, null]);
  });
  it('flows through extractFacts', async () => {
    const facts = [factSchema.parse({ key: 'pe', shape: 'events', unit: 'seconds', expr: 'purchases.{ "type": "purchase", "data": productKey, "ts": at, "attrs": { "currency": currency } }' })];
    const r = await extractFacts(facts, { data: { purchases: [{ at: 5, productKey: 'p', currency: 'gems' }] }, bindings: {} });
    expect(r.events).toEqual([{ type: 'purchase', data: 'p', ts: new Date(5000), attrs: { currency: 'gems' } }]);
  });
});

describe('config validation for supplemental stores', () => {
  const write = async (game: string[]) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-supp-'));
    await writeFile(path.join(dir, 'game.yaml'), ['universeId: 1', 'datastores:', ...game, ''].join('\n'));
    return dir;
  };
  const errorsOf = async (dir: string) => ((await loadConfig(dir).catch((e: unknown) => e)) as ConfigError).message;

  it('rejects a mount on the primary, overlapping mounts, and index discovery without an index', async () => {
    const dir = await write([
      '  - name: P',
      '    keyTemplate: "{userId}"',
      '    mount: nope',
      '  - name: A',
      '    keyTemplate: "{userId}"',
      '    mount: extras',
      '  - name: B',
      '    keyTemplate: "{userId}"',
      '    mount: extras.purchases',
      '    sync: { discovery: index }',
    ]);
    const text = await errorsOf(dir);
    expect(text).toMatch(/datastores\[0\]\.mount: the first \(primary\) datastore/);
    expect(text).toMatch(/mount "extras.purchases" overlaps with mount "extras"/);
    expect(text).toMatch(/datastores\[2\]\.sync\.discovery: "index" discovery requires sync\.index/);
  });

  it('rejects a malformed mount path structurally', async () => {
    const dir = await write(['  - name: P', '    keyTemplate: "{userId}"', '  - name: C', '    keyTemplate: "{userId}"', '    mount: "Bad-Path"']);
    expect(await errorsOf(dir)).toMatch(/datastores\.1\.mount: must be a snake_case identifier/);
  });

  it('rejects duplicate aliases including the mount-derived default', async () => {
    const dir = await write(['  - name: P', '    keyTemplate: "{userId}"', '  - name: A', '    keyTemplate: "{userId}"', '    mount: x.same', '  - name: B', '    keyTemplate: "{userId}"', '    mount: y.same']);
    expect(await errorsOf(dir)).toMatch(/duplicate datastore alias "same"/);
  });

  it('accepts the demo config with its mounted purchase store', async () => {
    const cfg = await loadConfig(path.resolve('examples/demo-game/config'));
    const p = cfg.game.datastores.find((x) => x.name === 'Purchases')!;
    expect(p.mount).toBe('purchases');
    expect(p.sync.discovery).toBe('list');
    expect(p.sync.backfill).toBe(false);
    expect(cfg.facts.some((f) => f.key === 'purchase_count')).toBe(true);
  });
});

describe('demo purchase store', () => {
  const players = generateDataset({ players: 400, seed: 7, now: 1_789_700_000, keyTemplate: 'Player_{userId}', envelope: 'documentservice' });

  it('is sparse, deterministic, timestamped within the player\'s activity, and keyed by bare user id', () => {
    const a = generatePurchases(players, { seed: 8 });
    const b = generatePurchases(players, { seed: 8 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(players.length * 0.02);
    expect(a.length).toBeLessThan(players.length * 0.1);
    const byUser = new Map(players.map((p) => [p.userId, p]));
    for (const e of a) {
      const p = byUser.get(e.userId)!;
      expect(e.key).toBe(String(e.userId));
      const list = e.value as DemoPurchase[];
      expect(list.length).toBeGreaterThan(0);
      for (const x of list) {
        expect(x.at * 1000).toBeGreaterThanOrEqual(new Date(p.createTime).getTime());
        expect(x.at * 1000).toBeLessThanOrEqual(new Date(p.revisionCreateTime).getTime());
      }
      expect(e.revisionCreateTime).toBe(new Date(list[list.length - 1]!.at * 1000).toISOString());
    }
  });

  it('tick adds purchases to some buyers and creates a few first-time buyers with revision history', () => {
    const list = generatePurchases(players, { seed: 8 });
    const before = list.length;
    const revs = new Map(list.map((e) => [e.key, e.revisionId]));
    const changed = tickPurchases(list, players, { fraction: 0.5, seed: 3, now: 1_790_300_000 });
    expect(changed).toBeGreaterThan(0);
    const bumped = list.filter((e) => revs.has(e.key) && revs.get(e.key) !== e.revisionId);
    expect(bumped.length + (list.length - before)).toBe(changed);
    expect(bumped.every((e) => (e.revisions?.length ?? 0) > 0)).toBe(true);
  });
});
