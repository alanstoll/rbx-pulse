/**
 * Integration test for segments/cohorts and export against Postgres.
 * Skipped unless PULSE_TEST_DATABASE_URL is set. Wipes the pulse tables first.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDataset, tickDataset } from '../src/demo/generate.js';
import { readDataset, writeDataset } from '../src/demo/dataset.js';
import { MockOpenCloud } from '../src/demo/mock-open-cloud.js';
import { migrate } from '../src/db/migrate.js';
import { resetDatabase } from './helpers/db.js';
import { loadConfig } from '../src/config/load.js';
import type { PulseConfig } from '../src/config/schema.js';
import { OpenCloudClient, RateLimiter, SyncStore, runSync } from '../src/sync/index.js';
import { assembleProfiles, extractProfiles, applyViews } from '../src/profile/index.js';

const url = process.env.PULSE_TEST_DATABASE_URL;

describe.skipIf(!url)('segments and cohorts (Postgres integration)', () => {
  let pool: pg.Pool;
  let mock: MockOpenCloud;
  let dir: string;
  let config: PulseConfig;
  const players = 40;
  const log = { info: () => {}, warn: (m: string) => console.warn(m) };
  const count = async (sql: string): Promise<number> => Number((await pool.query(sql)).rows[0].n);

  const sync = async () => {
    const limiter = new RateLimiter({ maxPerMinute: 6000, budgetFraction: 1 });
    const client = new OpenCloudClient({ baseUrl: config.game.baseUrl, apiKey: 'demo-key', universeId: '1', limiter });
    return runSync({ config, store: new SyncStore(pool), client, limiter, log, ignoreWindow: true });
  };
  const pipeline = async () => {
    await assembleProfiles(pool, log);
    const e = await extractProfiles(pool, config, log);
    await applyViews(pool, config);
    return e;
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await resetDatabase(pool);
    await migrate(pool);
    dir = await mkdtemp(path.join(tmpdir(), 'pulse-segdb-'));
    await writeDataset(dir, 'PlayerData', generateDataset({ players, seed: 31, now: 1_789_700_000, keyTemplate: 'Player_{userId}', envelope: 'documentservice' }));
    mock = new MockOpenCloud({ dataDir: dir, universeId: '1', apiKey: 'demo-key', rpm: 100_000 });
    const port = await mock.listen(0);
    const demo = await loadConfig(path.resolve('examples/demo-game/config'));
    config = { ...demo, game: { ...demo.game, baseUrl: `http://localhost:${port}` } };
    await sync();
  });
  afterAll(async () => {
    await mock.close();
    await pool.end();
  });

  it('writes one membership row per segment per version and exposes segment columns in the wide view', async () => {
    const e = await pipeline();
    expect(Object.keys(e.errors)).toEqual([]);
    expect(e.segmentsWritten).toBe(players * config.segments.length);
    expect(await count(`SELECT count(*) AS n FROM v_segment_current WHERE key = 'join_week' AND label IS NOT NULL`)).toBe(players);
    expect(await count(`SELECT count(*) AS n FROM v_segment_current WHERE key = 'is_premium' AND label IS NULL`)).toBe(players);
    const r = await pool.query(`SELECT user_id, is_premium, join_week, playtime_band, level_band, xp FROM v_player_current ORDER BY user_id LIMIT 5`);
    expect(r.rows).toHaveLength(5);
    expect(typeof r.rows[0].is_premium).toBe('boolean');
    expect(r.rows[0].join_week).toMatch(/^\d{4}-W\d{2}$/);
    expect(['under_1h', '1h_to_10h', 'over_10h']).toContain(r.rows[0].playtime_band);
    // premium segment agrees with premium fact
    expect(await count(`SELECT count(*) AS n FROM v_player_current WHERE is_premium IS DISTINCT FROM premium`)).toBe(0);
  });

  it('cohort composition can be reconstructed at any time, and membership closes with versions', async () => {
    const entries = await readDataset(dir, 'PlayerData');
    const changed = tickDataset(entries, { fraction: 0.5, seed: 8, now: 1_790_300_000 });
    await writeDataset(dir, 'PlayerData', entries);
    await sync();
    await pipeline();
    expect(await count(`SELECT count(*) AS n FROM segment_membership WHERE key = 'playtime_band' AND valid_to IS NOT NULL`)).toBe(changed);
    expect(await count(`SELECT count(*) AS n FROM v_segment_current WHERE key = 'playtime_band'`)).toBe(players);
    // Versions start at their write time. Just before the earliest second-version write,
    // every player is still on their first version, so composition equals the v1 labels.
    const firstV2 = (await pool.query(`SELECT min(valid_from) AS t FROM profile_version WHERE version_no = 2`)).rows[0].t as Date;
    const mid = new Date(firstV2.getTime() - 1000);
    const at = async (t: Date) => (await pool.query(`SELECT label, count(*)::int AS n FROM segment_membership WHERE key = 'playtime_band' AND valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1) GROUP BY label ORDER BY label`, [t])).rows;
    const atMid = await at(mid);
    const atNow = await at(new Date());
    expect(atMid.reduce((a: number, r: { n: number }) => a + r.n, 0)).toBe(players);
    expect(atNow.reduce((a: number, r: { n: number }) => a + r.n, 0)).toBe(players);
    const v1 = (await pool.query(`SELECT label, count(*)::int AS n FROM segment_membership s JOIN profile_version pv ON pv.id = s.profile_version_id WHERE s.key='playtime_band' AND pv.version_no = 1 GROUP BY label ORDER BY label`)).rows;
    expect(atMid).toEqual(v1);
  });

  it('v_player_activity reports last change per player', async () => {
    const r = await pool.query(`SELECT count(*)::int AS n, count(last_changed_at)::int AS changed FROM v_player_activity`);
    expect(r.rows[0].n).toBe(players);
    expect(r.rows[0].changed).toBe(players);
    expect(await count(`SELECT count(*) AS n FROM v_player_activity WHERE times_changed >= 2`)).toBeGreaterThan(0);
  });
});
