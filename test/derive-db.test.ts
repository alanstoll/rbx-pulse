/**
 * Integration test for the derive stage (milestones, flags, stat deltas).
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
import { assembleProfiles, extractProfiles, deriveProfiles } from '../src/profile/index.js';

const url = process.env.PULSE_TEST_DATABASE_URL;

describe.skipIf(!url)('derive stage (Postgres integration)', () => {
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
    await extractProfiles(pool, config, log);
    return deriveProfiles(pool, config, log);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await resetDatabase(pool);
    await migrate(pool);
    dir = await mkdtemp(path.join(tmpdir(), 'pulse-derdb-'));
    await writeDataset(dir, 'PlayerData', generateDataset({ players, seed: 21, now: 1_789_700_000, keyTemplate: 'Player_{userId}', envelope: 'documentservice' }));
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

  it('records milestones with exact timing and flags with bounded timing on the first pass', async () => {
    const d = await pipeline();
    expect(d.playersProcessed).toBe(players);
    expect(Object.keys(d.errors)).toEqual([]);
    expect(d.deltasWritten).toBe(0); // one version per player: nothing to diff yet

    const tut = await count(`SELECT count(*) AS n FROM milestone_event WHERE key = 'finished_tutorial'`);
    const tutFacts = await count(`SELECT count(*) AS n FROM fact WHERE key = 'quest_completed_at' AND dim = 'q_intro' AND valid_to IS NULL`);
    expect(tut).toBe(tutFacts);
    expect(await count(`SELECT count(*) AS n FROM milestone_event WHERE kind = 'milestone' AND precision <> 'exact'`)).toBe(0);
    // exact time equals the record's timestamp
    expect(await count(`SELECT count(*) AS n FROM milestone_event m JOIN fact f ON f.user_id = m.user_id AND f.key = 'quest_completed_at' AND f.dim = 'q_intro' AND f.valid_to IS NULL WHERE m.key = 'finished_tutorial' AND m.reached_hi <> f.ts`)).toBe(0);
    // ordered funnel: nobody has milestone n+1 without milestone n
    expect(await count(`SELECT count(*) AS n FROM milestone_event b WHERE b.kind='milestone' AND b.ordinal > 0 AND NOT EXISTS (SELECT 1 FROM milestone_event a WHERE a.user_id = b.user_id AND a.kind='milestone' AND a.ordinal = b.ordinal - 1)`)).toBe(0);

    const flags = await count(`SELECT count(*) AS n FROM milestone_event WHERE kind = 'flag'`);
    expect(flags).toBeGreaterThan(0);
    // first-version flags: bounded by entry creation and the revision time
    expect(await count(`SELECT count(*) AS n FROM milestone_event m JOIN player p ON p.user_id = m.user_id WHERE m.kind = 'flag' AND (m.precision <> 'revision' OR m.reached_lo <> p.entry_created_at)`)).toBe(0);
  });

  it('is idempotent', async () => {
    const before = await count('SELECT count(*) AS n FROM milestone_event');
    const d = await deriveProfiles(pool, config, log);
    expect(d.versionsProcessed).toBe(0);
    expect(await count('SELECT count(*) AS n FROM milestone_event')).toBe(before);
  });

  it('after a tick: new events are bounded by the previous observation, and deltas appear', async () => {
    const entries = await readDataset(dir, 'PlayerData');
    const changed = tickDataset(entries, { fraction: 0.5, seed: 4, now: 1_790_300_000 });
    // Force one counter reset for reset detection.
    const victim = entries.find((e) => (e.value as { data: { stats: { xp: number } } }).data.stats.xp > 0)!;
    (victim.value as { data: { stats: { xp: number } } }).data.stats.xp = 0;
    victim.revisionId = 'r-reset';
    victim.revisionCreateTime = new Date(1_790_300_000 * 1000).toISOString();
    await writeDataset(dir, 'PlayerData', entries);
    const s = await sync();
    expect(s.stats.changed).toBeGreaterThanOrEqual(changed);

    const before = await count('SELECT count(*) AS n FROM milestone_event');
    const d = await pipeline();
    expect(d.versionsProcessed).toBe(s.stats.changed);
    expect(d.deltasWritten).toBeGreaterThan(0);
    expect(await count('SELECT count(*) AS n FROM milestone_event')).toBeGreaterThanOrEqual(before);

    // Flags newly reached in version 2 are bounded by version 1's observation time.
    expect(await count(`SELECT count(*) AS n FROM milestone_event m JOIN profile_version v2 ON v2.id = m.profile_version_id AND v2.version_no = 2 JOIN profile_version v1 ON v1.user_id = m.user_id AND v1.version_no = 1 WHERE m.kind = 'flag' AND m.reached_lo <> v1.observed_at`)).toBe(0);
    // Deltas: xp per_day is positive for non-reset rows, and the reset is flagged.
    expect(await count(`SELECT count(*) AS n FROM stat_delta WHERE key = 'xp' AND NOT reset AND delta < 0`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM stat_delta WHERE key = 'xp' AND reset AND user_id = ${victim.userId}`)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM stat_delta WHERE per_day IS NULL`)).toBe(0);
    // gauges can go down without being a reset
    expect(await count(`SELECT count(*) AS n FROM stat_delta WHERE key = 'coins' AND reset`)).toBe(0);
  });

  it('a config change re-derives everything; rebuild does too', async () => {
    const cfg2: PulseConfig = { ...config, flags: [{ key: 'rich', when: 'stats.coins > 0', unit: 'seconds' }] };
    const d = await deriveProfiles(pool, cfg2, log);
    expect(d.versionsProcessed).toBe(await count('SELECT count(*) AS n FROM profile_version'));
    expect(await count(`SELECT count(*) AS n FROM milestone_event WHERE kind = 'flag' AND key <> 'rich'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM milestone_event WHERE key = 'rich'`)).toBeGreaterThan(0);
    const back = await deriveProfiles(pool, config, log, { rebuild: true });
    expect(back.versionsProcessed).toBe(await count('SELECT count(*) AS n FROM profile_version'));
    expect(await count(`SELECT count(*) AS n FROM milestone_event WHERE key = 'rich'`)).toBe(0);
  });
});
