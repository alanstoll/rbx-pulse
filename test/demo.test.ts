import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDataset, tickDataset, levelForXp } from '../src/demo/generate.js';
import { writeDataset } from '../src/demo/dataset.js';
import { MockOpenCloud } from '../src/demo/mock-open-cloud.js';
import { unwrap } from '../src/envelope/index.js';
import { evaluate } from '../src/expr/engine.js';

const NOW = 1_789_700_000;
const base = { players: 200, seed: 7, now: NOW, keyTemplate: 'Player_{userId}', envelope: 'documentservice' as const };

describe('demo generator', () => {
  it('is deterministic for a seed', () => {
    const a = generateDataset(base);
    const b = generateDataset(base);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(190);
  });

  it('produces records the demo config can evaluate', async () => {
    const [e] = generateDataset({ ...base, players: 5 });
    const { data } = unwrap('documentservice', e!.value);
    const level = await evaluate('$floor($sqrt(stats.xp / 100)) + 1', data);
    const xp = await evaluate('stats.xp', data);
    expect(level).toBe(levelForXp(xp as number));
    expect(await evaluate('$size(collection)', data)).toBeGreaterThanOrEqual(0);
    expect(await evaluate('$count($objects(inventory.slots))', data)).toBeLessThanOrEqual(8);
    const events = (await evaluate('recentEvents.{ "type": t, "data": $string(d), "ts": ts }', data)) as unknown[];
    expect(Array.isArray(events) || events === undefined).toBe(true);
  });

  it('tick changes roughly the requested fraction and bumps revisions', () => {
    const entries = generateDataset(base);
    const before = new Map(entries.map((e) => [e.key, e.revisionId]));
    const changed = tickDataset(entries, { fraction: 0.2, seed: 3, now: NOW + 7 * 86400 });
    expect(changed).toBeGreaterThan(entries.length * 0.1);
    expect(changed).toBeLessThan(entries.length * 0.3);
    const bumped = entries.filter((e) => before.get(e.key) !== e.revisionId).length;
    expect(bumped).toBe(changed);
  });
});

describe('mock Open Cloud', () => {
  let mock: MockOpenCloud;
  let port: number;
  let entries: ReturnType<typeof generateDataset>;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-demo-'));
    entries = generateDataset({ ...base, players: 30 });
    await writeDataset(dir, 'PlayerData', entries);
    mock = new MockOpenCloud({ dataDir: dir, universeId: '1', apiKey: 'k', rpm: 40 });
    port = await mock.listen(0);
  });
  afterAll(() => mock.close());

  const get = (p: string, key = 'k') => fetch(`http://localhost:${port}${p}`, { headers: { 'x-api-key': key } });

  it('rejects a bad api key', async () => {
    const r = await get('/cloud/v2/universes/1/data-stores/PlayerData/entries', 'nope');
    expect(r.status).toBe(401);
  });

  it('lists with pagination and gets an entry with metadata', async () => {
    const ids: string[] = [];
    let token: string | undefined;
    do {
      const r = await get(`/cloud/v2/universes/1/data-stores/PlayerData/entries?maxPageSize=12${token ? `&pageToken=${token}` : ''}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('x-ratelimit-limit')).toBe('40');
      const body = (await r.json()) as { dataStoreEntries: { id: string }[]; nextPageToken?: string };
      ids.push(...body.dataStoreEntries.map((e) => e.id.replace(/^global\//, '')));
      token = body.nextPageToken;
    } while (token);
    expect(ids.length).toBe(entries.length);

    const r = await get(`/cloud/v2/universes/1/data-stores/PlayerData/entries/${ids[0]}`);
    const body = (await r.json()) as { id: string; revisionCreateTime: string; createTime: string; value: { data: unknown } };
    expect(body.id).toBe(`global/${ids[0]}`);
    expect(body.createTime).toMatch(/T/);
    expect(body.value.data).toBeTruthy();

    const missing = await get('/cloud/v2/universes/1/data-stores/PlayerData/entries/Player_0');
    expect(missing.status).toBe(404);
    const wrongUniverse = await get('/cloud/v2/universes/2/data-stores/PlayerData/entries');
    expect(wrongUniverse.status).toBe(403);
  });

  it('throttles with 429 once the per-minute budget is spent', async () => {
    let last = 200;
    for (let i = 0; i < 60 && last !== 429; i++) {
      last = (await get('/cloud/v2/universes/1/data-stores/PlayerData/entries?maxPageSize=1')).status;
    }
    expect(last).toBe(429);
    expect(mock.stats.throttled).toBeGreaterThan(0);
  });
});
