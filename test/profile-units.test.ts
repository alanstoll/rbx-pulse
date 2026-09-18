import { describe, expect, it } from 'vitest';
import { composeVersions, isPrefix } from '../src/profile/assemble.js';
import { coerce, eventRows, extractFacts, extractSegments, keyedPairs } from '../src/profile/extract.js';
import { wideViewSql } from '../src/profile/views.js';
import { factSchema, segmentSchema } from '../src/config/schema.js';

const d = (s: string) => new Date(s);

describe('composeVersions', () => {
  it('one datastore: one version per snapshot, with validity intervals', () => {
    const v = composeVersions([
      { id: 2, datastore: 'A', observedAt: d('2026-01-08'), revisionCreatedAt: d('2026-01-07') },
      { id: 1, datastore: 'A', observedAt: d('2026-01-01'), revisionCreatedAt: d('2025-12-30') },
    ]);
    expect(v.map((x) => x.versionNo)).toEqual([1, 2]);
    expect(v[0]!.components).toEqual({ A: 1 });
    // Versions start at the write (revision) time; the observation time is kept separately.
    expect(v[0]!.validFrom).toEqual(d('2025-12-30'));
    expect(v[0]!.observedAt).toEqual(d('2026-01-01'));
    expect(v[0]!.validTo).toEqual(d('2026-01-07'));
    expect(v[1]!.validFrom).toEqual(d('2026-01-07'));
    expect(v[1]!.validTo).toBeNull();
    expect(v[1]!.revisionCreatedAt).toEqual(d('2026-01-07'));
  });

  it('two datastores: cuts a version whenever any component changes', () => {
    const v = composeVersions([
      { id: 1, datastore: 'A', observedAt: d('2026-01-01T00:00:00Z'), revisionCreatedAt: null },
      { id: 2, datastore: 'B', observedAt: d('2026-01-01T00:00:05Z'), revisionCreatedAt: null },
      { id: 3, datastore: 'B', observedAt: d('2026-01-08'), revisionCreatedAt: null },
    ]);
    expect(v.map((x) => x.components)).toEqual([{ A: 1 }, { A: 1, B: 2 }, { A: 1, B: 3 }]);
    expect(v.map((x) => x.maxSnapshotId)).toEqual([1, 2, 3]);
  });

  it('orders a backfilled (earlier write, later insert) snapshot before a synced one', () => {
    const v = composeVersions([
      { id: 1, datastore: 'A', observedAt: d('2026-09-10'), revisionCreatedAt: d('2026-09-09') },
      { id: 9, datastore: 'A', observedAt: d('2026-09-05'), revisionCreatedAt: d('2026-09-05') }, // backfill: observed = revision
    ]);
    expect(v.map((x) => x.components)).toEqual([{ A: 9 }, { A: 1 }]);
    expect(v[0]!.validTo).toEqual(d('2026-09-09'));
  });

  it('isPrefix detects divergence', () => {
    const computed = composeVersions([{ id: 1, datastore: 'A', observedAt: d('2026-01-01'), revisionCreatedAt: null }, { id: 2, datastore: 'A', observedAt: d('2026-01-02'), revisionCreatedAt: null }]);
    expect(isPrefix([{ versionNo: 1, components: { A: 1 } }], computed)).toBe(true);
    expect(isPrefix([{ versionNo: 1, components: { A: 9 } }], computed)).toBe(false);
    // JSONB hands keys back ordered by length, not alphabetically; that is not a divergence.
    const two = composeVersions([{ id: 1, datastore: 'PlayerData', observedAt: d('2026-01-01'), revisionCreatedAt: null }, { id: 2, datastore: 'Purchases', observedAt: d('2026-01-02'), revisionCreatedAt: null }]);
    expect(isPrefix([{ versionNo: 1, components: { PlayerData: 1 } }, { versionNo: 2, components: { Purchases: 2, PlayerData: 1 } }], two)).toBe(true);
    expect(isPrefix([{ versionNo: 1, components: { A: 1 } }, { versionNo: 2, components: { A: 2 } }, { versionNo: 3, components: { A: 3 } }], computed)).toBe(false);
  });
});

describe('coerce', () => {
  it('counters and gauges need finite numbers', () => {
    expect(coerce('counter', 5, undefined)).toMatchObject({ num: 5 });
    expect(coerce('gauge', '7.5', undefined)).toMatchObject({ num: 7.5 });
    expect(coerce('counter', 'x', undefined)).toBeNull();
    expect(coerce('counter', undefined, undefined)).toBeNull();
    expect(coerce('counter', true, undefined)).toBeNull();
  });
  it('booleans default to false when missing', () => {
    expect(coerce('boolean', undefined, undefined)).toMatchObject({ bool: false });
    expect(coerce('boolean', true, undefined)).toMatchObject({ bool: true });
    expect(coerce('boolean', 0, undefined)).toMatchObject({ bool: false });
    expect(coerce('boolean', { x: 1 }, undefined)).toMatchObject({ bool: true });
  });
  it('timestamps honour unit and treat 0 as unset', () => {
    expect(coerce('timestamp', 1786737517, 'seconds')?.ts?.toISOString()).toBe('2026-08-14T19:58:37.000Z');
    expect(coerce('timestamp', 1786737517000, 'millis')?.ts?.toISOString()).toBe('2026-08-14T19:58:37.000Z');
    expect(coerce('timestamp', 0, 'seconds')).toBeNull();
    expect(coerce('timestamp', '2026-06-11T19:02:44Z', 'seconds')?.ts?.getUTCFullYear()).toBe(2026);
  });
  it('labels stringify scalars', () => {
    expect(coerce('label', 'a', undefined)).toMatchObject({ text: 'a' });
    expect(coerce('label', 3, undefined)).toMatchObject({ text: '3' });
    expect(coerce('label', undefined, undefined)).toBeNull();
  });
});

describe('keyedPairs and eventRows', () => {
  it('accepts {dim,value} arrays, maps, single objects, and string sets', () => {
    expect(keyedPairs([{ dim: 'a', value: 1 }, { dim: 'b', value: 2 }])).toEqual([['a', 1], ['b', 2]]);
    expect(keyedPairs({ dim: 'a', value: 1 })).toEqual([['a', 1]]);
    expect(keyedPairs({ x: true, y: false })).toEqual([['x', true], ['y', false]]);
    expect(keyedPairs(['Torch', 'Shovel'])).toEqual([['Torch', true], ['Shovel', true]]);
    expect(keyedPairs([])).toEqual([]);
    expect(keyedPairs(undefined)).toEqual([]);
  });
  it('normalizes events', () => {
    const rows = eventRows([{ type: 'lvl', data: 3, ts: 1789495156 }, { type: 'disc', data: 'm1', ts: 0 }, { type: 'x' }], 'seconds');
    expect(rows).toEqual([{ type: 'lvl', data: '3', ts: new Date(1789495156000), attrs: null }]);
    expect(eventRows({ type: 'a', data: 'b', ts: 1 }, 'seconds')).toHaveLength(1);
  });
});

describe('extractFacts', () => {
  const facts = [
    { key: 'xp', semantics: 'counter', expr: 'stats.xp' },
    { key: 'level', semantics: 'gauge', expr: '$floor($sqrt(stats.xp / 100)) + 1' },
    { key: 'premium', semantics: 'boolean', expr: 'flags.premium' },
    { key: 'missing_bool', semantics: 'boolean', expr: 'flags.nope' },
    { key: 'created_at', semantics: 'timestamp', unit: 'seconds', expr: 'profile.createdAt' },
    { key: 'entry_created', semantics: 'timestamp', unit: 'seconds', expr: '$entry.createTime' },
    { key: 'lock', semantics: 'timestamp', unit: 'seconds', expr: '$meta.lockTimestamp' },
    { key: 'areas', shape: 'keyed', semantics: 'boolean', expr: '$entries(progress.areas).{ "dim": key, "value": value }' },
    { key: 'tools', shape: 'keyed', semantics: 'boolean', expr: 'tools' },
    { key: 'empty_map', shape: 'keyed', semantics: 'boolean', expr: '$entries(collection).{ "dim": key, "value": value.found }' },
    { key: 'bad', semantics: 'counter', expr: '$number("abc")' },
    { key: 'activity', shape: 'events', unit: 'seconds', expr: 'recentEvents.{ "type": t, "data": $string(d), "ts": ts }' },
  ].map((f) => factSchema.parse(f));

  const doc = {
    data: {
      stats: { xp: 2500 },
      flags: { premium: true },
      profile: { createdAt: 1786737517 },
      progress: { areas: { meadow: true, forest: true } },
      tools: ['Torch'],
      collection: [],
      recentEvents: [{ t: 'lvl', d: 5, ts: 1789495156 }, { t: 'lvl', d: 5, ts: 1789495156 }],
    },
    bindings: { meta: { lockTimestamp: 1789661566 }, entry: { createTime: '2026-06-11T19:02:44Z' }, stores: {} },
  };

  it('produces typed rows for every shape and reports expression errors', async () => {
    const r = await extractFacts(facts, doc);
    const byKey = Object.fromEntries(r.facts.map((f) => [`${f.key}${f.dim ? `[${f.dim}]` : ''}`, f]));
    expect(byKey['xp']).toMatchObject({ kind: 'counter', num: 2500 });
    expect(byKey['level']).toMatchObject({ num: 6 });
    expect(byKey['premium']).toMatchObject({ bool: true });
    expect(byKey['missing_bool']).toMatchObject({ bool: false });
    expect(byKey['created_at']!.ts?.toISOString()).toBe('2026-08-14T19:58:37.000Z');
    expect(byKey['entry_created']!.ts?.getUTCFullYear()).toBe(2026);
    expect(byKey['lock']!.ts).toBeTruthy();
    expect(byKey['areas[meadow]']).toMatchObject({ bool: true });
    expect(byKey['areas[forest]']).toMatchObject({ bool: true });
    expect(byKey['tools[Torch]']).toMatchObject({ bool: true });
    expect(Object.keys(byKey).some((k) => k.startsWith('empty_map'))).toBe(false);
    expect(byKey['bad']).toBeUndefined();
    expect(r.errors['bad']).toMatch(/./);
    expect(r.events).toHaveLength(2); // dedup happens in the database
  });
});

describe('extractSegments', () => {
  it('yields membership for boolean segments and labels for label segments', async () => {
    const segments = [
      { key: 'premium', boolean: 'flags.premium' },
      { key: 'missing', boolean: 'flags.nope' },
      { key: 'band', label: 'stats.xp < 1000 ? "low" : "high"' },
      { key: 'nolabel', label: 'flags.nope' },
      { key: 'broken', label: '$number("x")' },
    ].map((s) => segmentSchema.parse(s));
    const r = await extractSegments(segments, { data: { flags: { premium: true }, stats: { xp: 2500 } }, bindings: {} });
    const by = Object.fromEntries(r.segments.map((s) => [s.key, s]));
    expect(by['premium']).toEqual({ key: 'premium', member: true, label: null });
    expect(by['missing']).toEqual({ key: 'missing', member: false, label: null });
    expect(by['band']).toEqual({ key: 'band', member: true, label: 'high' });
    expect(by['nolabel']).toEqual({ key: 'nolabel', member: false, label: null });
    expect(by['broken']).toBeUndefined();
    expect(r.errors['broken']).toBeTruthy();
  });
});

describe('wideViewSql', () => {
  it('builds one typed column per scalar fact and per segment', () => {
    const facts = [
      { key: 'xp', semantics: 'counter', expr: 'a' },
      { key: 'premium', semantics: 'boolean', expr: 'b' },
      { key: 'joined', semantics: 'timestamp', unit: 'seconds', expr: 'c' },
      { key: 'band', semantics: 'label', expr: 'd' },
      { key: 'areas', shape: 'keyed', semantics: 'boolean', expr: 'e' },
    ].map((f) => factSchema.parse(f));
    const segments = [
      { key: 'premium_seg', boolean: 'b' },
      { key: 'join_week', label: 'c' },
    ].map((s) => segmentSchema.parse(s));
    const sql = wideViewSql(facts, segments).join('\n');
    expect(sql).toContain(`MAX(num) FILTER (WHERE key = 'xp' AND dim = '') AS "xp"`);
    expect(sql).toContain(`BOOL_OR(bool) FILTER (WHERE key = 'premium'`);
    expect(sql).toContain(`MAX(ts) FILTER (WHERE key = 'joined'`);
    expect(sql).toContain(`MAX(text) FILTER (WHERE key = 'band'`);
    expect(sql).toContain(`BOOL_OR(member) FILTER (WHERE key = 'premium_seg') AS "premium_seg"`);
    expect(sql).toContain(`MAX(label) FILTER (WHERE key = 'join_week') AS "join_week"`);
    expect(sql).toContain('FROM segment_membership GROUP BY profile_version_id');
    expect(sql).not.toContain('"areas"');
    expect(sql).toContain('CREATE VIEW v_player_current AS SELECT * FROM v_player_history WHERE valid_to IS NULL');
    expect(wideViewSql([], []).join('\n')).not.toContain('FROM fact');
    expect(sql).toContain('p.display_name');
  });
});
