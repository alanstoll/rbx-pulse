/**
 * Integration tests for Phase 5: incremental sync via a last-login index,
 * revision-history backfill, and users API enrichment. Postgres + mock server.
 * Skipped unless PULSE_TEST_DATABASE_URL is set. Wipes the pulse tables first.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDataset, tickDataset } from '../src/demo/generate.js';
import { readDataset, writeDataset, writeOrderedIndex, lastLoginIndex } from '../src/demo/dataset.js';
import { MockOpenCloud } from '../src/demo/mock-open-cloud.js';
import { migrate } from '../src/db/migrate.js';
import { resetDatabase } from './helpers/db.js';
import { loadConfig } from '../src/config/load.js';
import type { PulseConfig } from '../src/config/schema.js';
import { OpenCloudClient, RateLimiter, SyncStore, runSync, backfillRevisions, enrichPlayers } from '../src/sync/index.js';
import { assembleProfiles, extractProfiles, deriveProfiles } from '../src/profile/index.js';

const url = process.env.PULSE_TEST_DATABASE_URL;

describe.skipIf(!url)('phase 5: index sync, backfill, enrich (Postgres integration)', () => {
  let pool: pg.Pool;
  let mock: MockOpenCloud;
  let dir: string;
  let config: PulseConfig;
  const players = 50;
  const NOW = 1_789_700_000;
  const log = { info: () => {}, warn: (m: string) => console.warn(m) };
  const count = async (sql: string): Promise<number> => Number((await pool.query(sql)).rows[0].n);

  const client = () => {
    const limiter = new RateLimiter({ maxPerMinute: 6000, budgetFraction: 1 });
    return { client: new OpenCloudClient({ baseUrl: config.game.baseUrl, apiKey: 'demo-key', universeId: '1', limiter }), limiter };
  };
  const sync = async (opts: { full?: boolean } = {}) => {
    const c = client();
    return runSync({ config, store: new SyncStore(pool), client: c.client, limiter: c.limiter, log, ignoreWindow: true, full: opts.full });
  };
  const writeAll = async (entries: Awaited<ReturnType<typeof readDataset>>) => {
    await writeDataset(dir, 'PlayerData', entries);
    await writeOrderedIndex(dir, 'LastLogin', lastLoginIndex(entries));
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await resetDatabase(pool);
    await migrate(pool);
    dir = await mkdtemp(path.join(tmpdir(), 'pulse-p5-'));
    await writeAll(generateDataset({ players, seed: 41, now: NOW, keyTemplate: 'Player_{userId}', envelope: 'documentservice' }));
    mock = new MockOpenCloud({ dataDir: dir, universeId: '1', apiKey: 'demo-key', rpm: 100_000 });
    const port = await mock.listen(0);
    const demo = await loadConfig(path.resolve('examples/demo-game/config'));
    config = {
      ...demo,
      game: {
        ...demo.game,
        baseUrl: `http://localhost:${port}`,
        sync: { ...demo.game.sync, index: { orderedDatastore: 'LastLogin', scope: 'global', keyTemplate: '{userId}', valueUnit: 'seconds', marginMinutes: 0 } },
      },
    };
  });
  afterAll(async () => {
    await mock.close();
    await pool.end();
  });

  it('first sync is full; the next is incremental and fetches only players active since', async () => {
    const r1 = await sync();
    expect(r1.status).toBe('completed');
    expect(r1.stats.mode).toBe('full');
    expect(r1.stats.checked).toBe(players);

    // Nothing changed: incremental run lists the index and fetches nobody.
    const r2 = await sync();
    expect(r2.stats.mode).toBe('index');
    expect(r2.stats.checked).toBe(0);
    expect(r2.stats.requests).toBeLessThan(5);

    // Some players return with a last-login after the previous run's start. The tick
    // spreads sessions over the six days before `now`, so put `now` a week ahead to
    // guarantee every session lands after the previous sync.
    const entries = await readDataset(dir, 'PlayerData');
    const nowSec = Math.floor(Date.now() / 1000) + 7 * 86400;
    const changed = tickDataset(entries, { fraction: 0.2, seed: 5, now: nowSec });
    await writeAll(entries);
    const r3 = await sync();
    expect(r3.stats.mode).toBe('index');
    expect(r3.stats.checked).toBe(changed);
    expect(r3.stats.changed).toBe(changed);

    // --full lists everyone again.
    const r4 = await sync({ full: true });
    expect(r4.stats.mode).toBe('full');
    expect(r4.stats.checked).toBe(players);
    expect(r4.stats.changed).toBe(0);
  });

  it('backfill adds earlier snapshots from revision history and the pipeline rebuilds versions', async () => {
    const before = await count('SELECT count(*) AS n FROM snapshot');
    const withHistory = (await readDataset(dir, 'PlayerData')).filter((e) => (e.revisions?.length ?? 0) > 0).length;
    expect(withHistory).toBeGreaterThan(0);
    const c = client();
    const b = await backfillRevisions(pool, config, c.client, log, { days: 3650, maxRevisions: 10 });
    expect(b.playersConsidered).toBeGreaterThan(0);
    // Every player with history gets exactly one earlier state (the pre-tick value), which
    // the sync already stored as version 1, so it is deduplicated by hash: 0 inserts.
    expect(b.snapshotsInserted).toBe(0);
    expect(await count('SELECT count(*) AS n FROM snapshot')).toBe(before);

    // Now a case where history holds a state the sync never saw: tick twice before syncing.
    const entries = await readDataset(dir, 'PlayerData');
    const t1 = Math.floor(Date.now() / 1000) + 14 * 86400;
    const changedA = tickDataset(entries, { fraction: 0.3, seed: 6, now: t1 });
    await writeAll(entries);
    const changedB = tickDataset(entries, { fraction: 0.3, seed: 7, now: t1 + 600 });
    await writeAll(entries);
    expect(changedA + changedB).toBeGreaterThan(0);
    await sync({ full: true });
    const b2 = await backfillRevisions(pool, config, c.client, log, { days: 3650, maxRevisions: 10 });
    expect(b2.snapshotsInserted).toBeGreaterThan(0);
    expect(await count(`SELECT count(*) AS n FROM snapshot WHERE source = 'backfill'`)).toBe(b2.snapshotsInserted);

    await assembleProfiles(pool, log);
    await extractProfiles(pool, config, log);
    const d = await deriveProfiles(pool, config, log);
    expect(d.deltasWritten).toBeGreaterThan(0);
    // Backfilled snapshots are ordered by revision time, so versions stay monotonic in xp.
    const dec = await count(`SELECT count(*) AS n FROM stat_delta WHERE key = 'xp' AND delta < 0`);
    expect(dec).toBe(0);
    // A player with a backfilled snapshot has more versions than syncs that saw them change.
    expect(await count(`SELECT count(*) AS n FROM profile_version pv WHERE EXISTS (SELECT 1 FROM snapshot s WHERE s.id = (pv.components->>'PlayerData')::bigint AND s.source = 'backfill')`)).toBe(b2.snapshotsInserted);
  });

  it('enrich fills player identity from the users API', async () => {
    const c = client();
    const e = await enrichPlayers(pool, c.client, log, { refreshDays: 0 });
    expect(e.attempted).toBe(players);
    expect(e.updated).toBe(players);
    expect(await count(`SELECT count(*) AS n FROM player WHERE display_name LIKE 'Demo %' AND username LIKE 'demo_%' AND account_created_at IS NOT NULL`)).toBe(players);
    // second pass with refreshDays 0 does nothing
    expect((await enrichPlayers(pool, c.client, log, { refreshDays: 0 })).attempted).toBe(0);
    // premium mirrors the record flag in the demo
    expect(await count(`SELECT count(*) AS n FROM player p JOIN v_fact_current f ON f.user_id = p.user_id AND f.key = 'premium' WHERE p.premium IS DISTINCT FROM f.bool`)).toBe(0);
  });
});
