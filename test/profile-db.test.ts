/**
 * Integration test for assemble + extract + views against Postgres.
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

describe.skipIf(!url)('profiles and facts (Postgres integration)', () => {
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

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await resetDatabase(pool);
    await migrate(pool);
    dir = await mkdtemp(path.join(tmpdir(), 'pulse-profdb-'));
    await writeDataset(dir, 'PlayerData', generateDataset({ players, seed: 11, now: 1_789_700_000, keyTemplate: 'Player_{userId}', envelope: 'documentservice' }));
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

  it('assembles one version per player and extracts every fact', async () => {
    const a = await assembleProfiles(pool, log);
    expect(a.playersExamined).toBe(players);
    expect(a.versionsCreated).toBe(players);
    const e = await extractProfiles(pool, config, log);
    expect(e.versionsExtracted).toBe(players);
    expect(Object.keys(e.errors)).toEqual([]);
    expect(await count(`SELECT count(*) AS n FROM fact WHERE key = 'xp'`)).toBe(players);
    expect(await count(`SELECT count(*) AS n FROM fact WHERE key = 'level'`)).toBe(players);
    expect(await count(`SELECT count(DISTINCT user_id) AS n FROM fact WHERE key = 'area_unlocked' AND dim = 'meadow'`)).toBe(players);
    expect(await count(`SELECT count(*) AS n FROM event`)).toBeGreaterThan(0);
    // level derived from xp matches
    const bad = await count(`SELECT count(*) AS n FROM fact x JOIN fact l ON l.profile_version_id = x.profile_version_id AND l.key='level' WHERE x.key='xp' AND l.num <> floor(sqrt(x.num/100)) + 1`);
    expect(bad).toBe(0);
  });

  it('generates wide views that Grafana can query', async () => {
    const v = await applyViews(pool, config);
    expect(v.changed).toBe(true);
    const r = await pool.query(`SELECT user_id, xp, level, premium, created_at, music_setting FROM v_player_current ORDER BY xp DESC LIMIT 3`);
    expect(r.rows.length).toBe(3);
    expect(typeof r.rows[0].xp).toBe('number');
    expect(await count('SELECT count(*) AS n FROM v_player_current')).toBe(players);
    expect((await applyViews(pool, config)).changed).toBe(false);
  });

  it('a second extract is a no-op; a tick + sync adds versions and closes the old ones', async () => {
    expect((await extractProfiles(pool, config, log)).versionsExtracted).toBe(0);
    expect((await assembleProfiles(pool, log)).versionsCreated).toBe(0);

    const entries = await readDataset(dir, 'PlayerData');
    const changed = tickDataset(entries, { fraction: 0.3, seed: 2, now: 1_790_300_000 });
    await writeDataset(dir, 'PlayerData', entries);
    const s = await sync();
    expect(s.stats.changed).toBe(changed);

    const a = await assembleProfiles(pool, log);
    expect(a.versionsCreated).toBe(changed);
    expect(a.playersRebuilt).toBe(0);
    const e = await extractProfiles(pool, config, log);
    expect(e.versionsExtracted).toBe(changed);

    expect(await count('SELECT count(*) AS n FROM profile_version WHERE valid_to IS NULL')).toBe(players);
    expect(await count('SELECT count(*) AS n FROM profile_version WHERE valid_to IS NOT NULL')).toBe(changed);
    expect(await count(`SELECT count(*) AS n FROM fact WHERE key='xp' AND valid_to IS NULL`)).toBe(players);
    expect(await count(`SELECT count(*) AS n FROM fact WHERE key='xp' AND valid_to IS NOT NULL`)).toBe(changed);
    expect(await count('SELECT count(*) AS n FROM v_player_current')).toBe(players);
    // counters never decrease across versions in the demo
    const dec = await count(`SELECT count(*) AS n FROM fact a JOIN fact b ON a.user_id=b.user_id AND a.key=b.key AND b.key='xp' AND a.valid_to = b.valid_from WHERE a.key='xp' AND b.num < a.num`);
    expect(dec).toBe(0);
  });

  it('changing the facts config re-extracts every version and updates the views', async () => {
    const cfg2: PulseConfig = { ...config, facts: config.facts.filter((f) => f.key !== 'level').concat([{ key: 'xp_k', shape: 'scalar', semantics: 'gauge', expr: 'stats.xp / 1000' }]) };
    const e = await extractProfiles(pool, cfg2, log);
    expect(e.versionsExtracted).toBe(await count('SELECT count(*) AS n FROM profile_version'));
    expect(await count(`SELECT count(*) AS n FROM fact WHERE key='level'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM fact WHERE key='xp_k'`)).toBeGreaterThan(0);
    await applyViews(pool, cfg2);
    const r = await pool.query('SELECT xp_k FROM v_player_current LIMIT 1');
    expect(r.rows[0]).toHaveProperty('xp_k');
    // and back
    await extractProfiles(pool, config, log);
    await applyViews(pool, config);
  });

  it('rebuild recreates versions and keeps harvested events', async () => {
    const eventsBefore = await count('SELECT count(*) AS n FROM event');
    const versionsBefore = await count('SELECT count(*) AS n FROM profile_version');
    const a = await assembleProfiles(pool, log, { rebuild: true });
    expect(a.versionsCreated).toBe(versionsBefore);
    await extractProfiles(pool, config, log);
    expect(await count('SELECT count(*) AS n FROM event')).toBe(eventsBefore);
    expect(await count('SELECT count(*) AS n FROM fact WHERE valid_to IS NULL AND key = \'xp\'')).toBe(players);
  });

  it('purging a player removes versions, facts and events', async () => {
    const userId = Number((await pool.query('SELECT user_id FROM player LIMIT 1')).rows[0].user_id);
    await new SyncStore(pool).purge(userId);
    expect(await count(`SELECT count(*) AS n FROM profile_version WHERE user_id = ${userId}`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM fact WHERE user_id = ${userId}`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM event WHERE user_id = ${userId}`)).toBe(0);
  });
});
