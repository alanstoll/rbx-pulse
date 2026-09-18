import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { milestoneTiming, isTruthy } from '../src/profile/derive.js';
import { loadConfig } from '../src/config/load.js';
import { evaluate } from '../src/expr/engine.js';

const d = (s: string) => new Date(s);

describe('milestoneTiming', () => {
  const version = { validFrom: d('2026-09-10T00:00:00Z'), revisionCreatedAt: d('2026-09-08T12:00:00Z') };

  it('uses the record timestamp when present: exact', () => {
    const t = milestoneTiming({ at: d('2026-09-01'), version, previous: { validFrom: d('2026-09-03') }, entryCreatedAt: null });
    expect(t).toEqual({ lo: d('2026-09-01'), hi: d('2026-09-01'), precision: 'exact' });
  });

  it('bounds by previous observation and this revision: revision', () => {
    const t = milestoneTiming({ at: null, version, previous: { validFrom: d('2026-09-03') }, entryCreatedAt: d('2026-01-01') });
    expect(t).toEqual({ lo: d('2026-09-03'), hi: d('2026-09-08T12:00:00Z'), precision: 'revision' });
  });

  it('falls back to entry creation for the first version', () => {
    const t = milestoneTiming({ at: null, version, previous: null, entryCreatedAt: d('2026-01-01') });
    expect(t.lo).toEqual(d('2026-01-01'));
    expect(t.precision).toBe('revision');
  });

  it('uses the observation time when no revision time exists: interval', () => {
    const t = milestoneTiming({ at: null, version: { validFrom: d('2026-09-10'), revisionCreatedAt: null }, previous: { validFrom: d('2026-09-03') }, entryCreatedAt: null });
    expect(t).toEqual({ lo: d('2026-09-03'), hi: d('2026-09-10'), precision: 'interval' });
  });

  it('drops an impossible lower bound', () => {
    const t = milestoneTiming({ at: null, version, previous: { validFrom: d('2026-09-09') }, entryCreatedAt: null });
    expect(t.lo).toBeNull();
  });
});

describe('isTruthy', () => {
  it('treats JSONata-ish results sensibly', () => {
    expect(isTruthy(true)).toBe(true);
    expect(isTruthy({ at: 1 })).toBe(true);
    expect(isTruthy([1])).toBe(true);
    expect(isTruthy(5)).toBe(true);
    expect(isTruthy(undefined)).toBe(false);
    expect(isTruthy(false)).toBe(false);
    expect(isTruthy(0)).toBe(false);
    expect(isTruthy('')).toBe(false);
    expect(isTruthy([])).toBe(false);
  });
});

describe('constants', () => {
  it('loads constants.yaml and exposes them as bindings', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-const-'));
    await writeFile(path.join(dir, 'game.yaml'), ['universeId: 1', 'datastores:', '  - name: D', '    keyTemplate: "{userId}"', ''].join('\n'));
    await writeFile(path.join(dir, 'constants.yaml'), ['levelThresholds: [0, 1000, 2500, 4500]', 'label: hi', ''].join('\n'));
    const cfg = await loadConfig(dir);
    expect(cfg.constants.label).toBe('hi');
    const level = await evaluate('$count($levelThresholds[$ <= $$.xp])', { xp: 2600 }, cfg.constants);
    expect(level).toBe(3);
    expect(await evaluate('$count($levelThresholds[$ <= $$.xp])', { xp: 0 }, cfg.constants)).toBe(1);
    expect(await evaluate('$count($levelThresholds[$ <= $$.xp])', {}, cfg.constants)).toBe(0);
  });

  it('rejects reserved binding names', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-const-'));
    await writeFile(path.join(dir, 'game.yaml'), ['universeId: 1', 'datastores:', '  - name: D', '    keyTemplate: "{userId}"', ''].join('\n'));
    await writeFile(path.join(dir, 'constants.yaml'), 'meta: 1\n');
    await expect(loadConfig(dir)).rejects.toThrow(/reserved binding name/);
  });
});
