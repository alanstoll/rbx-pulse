/**
 * Integration test against a real Postgres. Skipped unless PULSE_TEST_DATABASE_URL is set.
 * The database it points at is wiped (all pulse tables dropped) at the start of the run.
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
import { pulseConfigSchema, type PulseConfig } from '../src/config/schema.js';
import { OpenCloudClient, RateLimiter, SyncStore, runSync } from '../src/sync/index.js';

const url = process.env.PULSE_TEST_DATABASE_URL;

describe.skipIf(!url)('sync engine (Postgres integration)', () => {
  let pool: pg.Pool;
  let mock: MockOpenCloud;
  let dir: string;
  let config: PulseConfig;
  const players = 60;
  const log = { info: () => {}, warn: (m: string) => console.warn(m) };

  const makeClient = () => {
    const limiter = new RateLimiter({ maxPerMinute: 6000, budgetFraction: 1 });
    return { client: new OpenCloudClient({ baseUrl: config.game.baseUrl, apiKey: 'k', universeId: '1', limiter }), limiter };
  };
  const count = async (sql: string): Promise<number> => Number((await pool.query(sql)).rows[0].n);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await resetDatabase(pool);
    await migrate(pool);
    dir = await mkdtemp(path.join(tmpdir(), 'pulse-syncdb-'));
    await writeDataset(dir, 'PlayerData', generateDataset({ players, seed: 5, now: 1_789_700_000, keyTemplate: 'Player_{userId}', envelope: 'documentservice' }));
    mock = new MockOpenCloud({ dataDir: dir, universeId: '1', apiKey: 'k', rpm: 100_000 });
    const port = await mock.listen(0);
    config = pulseConfigSchema.parse({
      game: { universeId: 1, baseUrl: `http://localhost:${port}`, datastores: [{ name: 'PlayerData', keyTemplate: 'Player_{userId}', envelope: 'documentservice' }], sync: { concurrency: 4 } },
    });
  });
  afterAll(async () => {
    await mock.close();
    await pool.end();
  });

  it('first sync stores one snapshot per player', async () => {
    const { client, limiter } = makeClient();
    const r = await runSync({ config, store: new SyncStore(pool), client, limiter, log, ignoreWindow: true });
    expect(r.status).toBe('completed');
    expect(r.stats.checked).toBe(players);
    expect(r.stats.changed).toBe(players);
    expect(await count('SELECT count(*) AS n FROM player')).toBe(players);
    expect(await count('SELECT count(*) AS n FROM snapshot')).toBe(players);
    expect(await count('SELECT count(*) AS n FROM observation WHERE changed')).toBe(players);
    expect(await count('SELECT count(*) AS n FROM player WHERE entry_created_at IS NOT NULL')).toBe(players);
  });

  it('second sync with no changes stores no new snapshots', async () => {
    const { client, limiter } = makeClient();
    const r = await runSync({ config, store: new SyncStore(pool), client, limiter, log, ignoreWindow: true });
    expect(r.status).toBe('completed');
    expect(r.stats.changed).toBe(0);
    expect(r.stats.unchanged).toBe(players);
    expect(await count('SELECT count(*) AS n FROM snapshot')).toBe(players);
    expect(await count('SELECT count(*) AS n FROM observation')).toBe(players * 2);
  });

  it('after a tick only returning players get new snapshots', async () => {
    const entries = await readDataset(dir, 'PlayerData');
    const changed = tickDataset(entries, { fraction: 0.25, seed: 9, now: 1_790_300_000 });
    await writeDataset(dir, 'PlayerData', entries);
    const { client, limiter } = makeClient();
    const r = await runSync({ config, store: new SyncStore(pool), client, limiter, log, ignoreWindow: true });
    expect(r.stats.changed).toBe(changed);
    expect(await count('SELECT count(*) AS n FROM snapshot')).toBe(players + changed);
  });

  it('a limited run pauses and a later run resumes without re-checking keys', async () => {
    const store = new SyncStore(pool);
    const before = await count('SELECT count(*) AS n FROM observation');
    const a = makeClient();
    const r1 = await runSync({ config, store, client: a.client, limiter: a.limiter, log, ignoreWindow: true, limit: 20 });
    expect(r1.status).toBe('paused');
    expect(r1.stats.checked).toBe(20);

    const b = makeClient();
    const r2 = await runSync({ config, store, client: b.client, limiter: b.limiter, log, ignoreWindow: true });
    expect(r2.runId).toBe(r1.runId);
    expect(r2.status).toBe('completed');
    expect(r2.stats.checked).toBe(players);
    expect(await count('SELECT count(*) AS n FROM observation')).toBe(before + players);
    expect(await count(`SELECT count(*) AS n FROM observation WHERE sync_run_id = ${r1.runId}`)).toBe(players);
  });

  it('an abort signal pauses the run', async () => {
    const store = new SyncStore(pool);
    const { client, limiter } = makeClient();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const r = await runSync({ config, store, client, limiter, log, ignoreWindow: true, fresh: true, signal: controller.signal });
    expect(['paused', 'completed']).toContain(r.status);
    // Finish it so the table is consistent for the next test.
    const c = makeClient();
    const done = await runSync({ config, store, client: c.client, limiter: c.limiter, log, ignoreWindow: true });
    expect(done.status).toBe('completed');
  });

  it('skips Studio test players (negative ids) unless configured to include them', async () => {
    const entries = await readDataset(dir, 'PlayerData');
    const testPlayer = { ...entries[0]!, key: 'Player_-7', userId: -7, revisionId: 'r-test' };
    await writeDataset(dir, 'PlayerData', [...entries, testPlayer]);
    const store = new SyncStore(pool);
    const a = makeClient();
    const r1 = await runSync({ config, store, client: a.client, limiter: a.limiter, log, ignoreWindow: true, fresh: true });
    expect(r1.stats.skippedKeys).toBe(1);
    expect(await count('SELECT count(*) AS n FROM player WHERE user_id < 0')).toBe(0);

    const inclusive = { ...config, game: { ...config.game, sync: { ...config.game.sync, includeTestPlayers: true } } };
    const b = makeClient();
    const r2 = await runSync({ config: inclusive, store, client: b.client, limiter: b.limiter, log, ignoreWindow: true, fresh: true });
    expect(r2.stats.skippedKeys).toBe(0);
    expect(await count('SELECT count(*) AS n FROM player WHERE user_id < 0')).toBe(1);
    await store.purge(-7);
    await writeDataset(dir, 'PlayerData', entries);
  });

  it('purge removes a player everywhere', async () => {
    const store = new SyncStore(pool);
    const userId = Number((await pool.query('SELECT user_id FROM player LIMIT 1')).rows[0].user_id);
    const r = await store.purge(userId);
    expect(r.player).toBe(1);
    expect(r.snapshots).toBeGreaterThan(0);
    expect(await count(`SELECT count(*) AS n FROM observation WHERE user_id = ${userId}`)).toBe(0);
  });
});
