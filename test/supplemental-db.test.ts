/**
 * Supplemental datastores end to end against Postgres and the mock server: list vs
 * index discovery, absent observations, per-datastore incremental cutoffs, retroactive
 * interleaving on first sync of a new store, mounted facts, flags and events.
 * Skipped unless PULSE_TEST_DATABASE_URL is set. Wipes the pulse tables first.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDataset, generatePurchases, tickDataset, tickPurchases, type DemoPurchase } from '../src/demo/generate.js';
import { readDataset, writeDataset, writeOrderedIndex, lastLoginIndex } from '../src/demo/dataset.js';
import { MockOpenCloud } from '../src/demo/mock-open-cloud.js';
import { migrate } from '../src/db/migrate.js';
import { resetDatabase } from './helpers/db.js';
import { loadConfig } from '../src/config/load.js';
import type { PulseConfig } from '../src/config/schema.js';
import { OpenCloudClient, RateLimiter, SyncStore, runSync, backfillRevisions } from '../src/sync/index.js';
import { assembleProfiles, extractProfiles, deriveProfiles, applyViews } from '../src/profile/index.js';

const url = process.env.PULSE_TEST_DATABASE_URL;

describe.skipIf(!url)('supplemental datastores (Postgres integration)', () => {
  let pool: pg.Pool;
  let mock: MockOpenCloud;
  let dir: string;
  let config: PulseConfig;
  let primaryOnly: PulseConfig;
  let purchases: Awaited<ReturnType<typeof readDataset>>;
  const players = 60;
  const NOW = 1_789_700_000;
  const log = { info: () => {}, warn: (m: string) => console.warn(m) };
  const count = async (sql: string): Promise<number> => Number((await pool.query(sql)).rows[0].n);

  const sync = async (cfg: PulseConfig, opts: { full?: boolean; datastores?: string[]; fresh?: boolean } = {}) => {
    const limiter = new RateLimiter({ maxPerMinute: 60_000, budgetFraction: 1 });
    const client = new OpenCloudClient({ baseUrl: cfg.game.baseUrl, apiKey: 'demo-key', universeId: '1', limiter });
    const r = await runSync({ config: cfg, store: new SyncStore(pool), client, limiter, log, ignoreWindow: true, ...opts });
    return { ...r, requests: client.stats.requests };
  };
  const pipeline = async (cfg: PulseConfig) => {
    const a = await assembleProfiles(pool, log, { primary: cfg.game.datastores[0]!.name });
    const e = await extractProfiles(pool, cfg, log);
    const d = await deriveProfiles(pool, cfg, log);
    await applyViews(pool, cfg);
    return { a, e, d };
  };
  const writeAll = async (entries: Awaited<ReturnType<typeof readDataset>>) => {
    await writeDataset(dir, 'PlayerData', entries);
    await writeOrderedIndex(dir, 'LastLogin', lastLoginIndex(entries));
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await resetDatabase(pool);
    await migrate(pool);
    dir = await mkdtemp(path.join(tmpdir(), 'pulse-supp-'));
    const entries = generateDataset({ players, seed: 23, now: NOW, keyTemplate: 'Player_{userId}', envelope: 'documentservice' });
    await writeAll(entries);
    purchases = generatePurchases(entries, { seed: 24, fraction: 0.15 });
    await writeDataset(dir, 'Purchases', purchases);
    mock = new MockOpenCloud({ dataDir: dir, universeId: '1', apiKey: 'demo-key', rpm: 1_000_000 });
    const port = await mock.listen(0);
    const demo = await loadConfig(path.resolve('examples/demo-game/config'));
    config = {
      ...demo,
      game: { ...demo.game, baseUrl: `http://localhost:${port}`, sync: { ...demo.game.sync, index: { orderedDatastore: 'LastLogin', scope: 'global', keyTemplate: '{userId}', valueUnit: 'seconds', marginMinutes: 0 } } },
    };
    primaryOnly = { ...config, game: { ...config.game, datastores: [config.game.datastores[0]!] } };
  });
  afterAll(async () => {
    await mock.close();
    await pool.end();
  });

  it('a primary-only sync plus pipeline gives every player a version with no purchases', async () => {
    const r = await sync(primaryOnly);
    expect(r.status).toBe('completed');
    expect(r.stats.checked).toBe(players);
    const { a, e } = await pipeline(primaryOnly);
    expect(a.versionsCreated).toBe(players);
    expect(Object.keys(e.errors)).toEqual([]);
    expect(await count(`SELECT count(*) AS n FROM fact WHERE key = 'purchase_count' AND num = 0`)).toBe(players);
    expect(await count(`SELECT count(*) AS n FROM fact WHERE key = 'robux_spent' AND num = 0`)).toBe(players);
    expect(await count(`SELECT count(*) AS n FROM fact WHERE key = 'first_purchase_at'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM milestone_event WHERE key = 'first_purchase'`)).toBe(0);
  });

  it('adding the store: --datastore lists only it (list discovery) and never probes non-buyers', async () => {
    const r = await sync(config, { datastores: ['Purchases'] });
    expect(r.status).toBe('completed');
    const d = r.stats.datastores!['Purchases']!;
    expect(d.mode).toBe('full');
    expect(d.listed).toBe(purchases.length);
    expect(d.checked).toBe(purchases.length);
    expect(d.changed).toBe(purchases.length);
    expect(r.stats.absent).toBe(0);
    expect(r.stats.datastores!['PlayerData']).toBeUndefined();
    // Listing pages + one read per key; no per-player probing.
    expect(r.requests).toBeLessThanOrEqual(purchases.length + 2);
    expect(await count(`SELECT count(*) AS n FROM snapshot WHERE datastore = 'Purchases'`)).toBe(purchases.length);
  });

  it('the pipeline interleaves purchase snapshots at their write time and rebuilds only buyers', async () => {
    const { a, e, d } = await pipeline(config);
    expect(a.playersRebuilt).toBe(purchases.length);
    expect(a.versionsCreated).toBeGreaterThanOrEqual(purchases.length);
    expect(Object.keys(e.errors)).toEqual([]);
    expect(d.eventsCreated).toBeGreaterThan(0);
    // Every buyer's current version has the purchase component and the right count.
    const rows = await pool.query<{ user_id: string; purchase_count: number; robux_spent: number; purchaser: boolean; first_purchase_at: Date | null }>(
      `SELECT user_id, purchase_count, robux_spent, purchaser, first_purchase_at FROM v_player_current WHERE purchase_count > 0 ORDER BY user_id`,
    );
    expect(rows.rows.length).toBe(purchases.length);
    for (const row of rows.rows) {
      const list = purchases.find((p) => p.userId === Number(row.user_id))!.value as DemoPurchase[];
      expect(row.purchase_count).toBe(list.length);
      expect(row.robux_spent).toBe(list.reduce((s, x) => s + x.robuxSpent, 0));
      expect(row.purchaser).toBe(true);
      expect(row.first_purchase_at!.getTime()).toBe(list[0]!.at * 1000);
    }
    expect(await count(`SELECT count(*) AS n FROM v_player_current WHERE purchaser`)).toBe(purchases.length);
    expect(await count(`SELECT count(*) AS n FROM v_player_current`)).toBe(players);
    // Versions never precede the first primary snapshot: every version has the primary component.
    expect(await count(`SELECT count(*) AS n FROM profile_version WHERE NOT (components ? 'PlayerData')`)).toBe(0);
    // Buyers whose purchase record was written before the primary's revision time got the purchase in version 1.
    const early = await count(
      `SELECT count(*) AS n FROM profile_version pv JOIN snapshot s ON s.id = (pv.components->>'Purchases')::bigint
        WHERE pv.version_no = 1 AND s.datastore = 'Purchases'`,
    );
    expect(early).toBe(purchases.length);
  });

  it('flags from a timestamped list are exact; events carry attrs', async () => {
    const total = purchases.reduce((s, p) => s + (p.value as DemoPurchase[]).length, 0);
    expect(await count(`SELECT count(*) AS n FROM event WHERE type = 'purchase'`)).toBe(total);
    expect(await count(`SELECT count(*) AS n FROM event WHERE type = 'purchase' AND attrs->>'currency' IS NOT NULL`)).toBe(total);
    expect(await count(`SELECT count(*) AS n FROM milestone_event WHERE key = 'first_purchase'`)).toBe(purchases.length);
    expect(await count(`SELECT count(*) AS n FROM milestone_event WHERE key = 'first_purchase' AND precision <> 'exact'`)).toBe(0);
    const payers = purchases.filter((p) => (p.value as DemoPurchase[]).some((x) => x.robuxSpent > 0)).length;
    expect(await count(`SELECT count(*) AS n FROM milestone_event WHERE key = 'paid_robux'`)).toBe(payers);
  });

  it('the next full run keeps the primary incremental while the purchase store lists itself', async () => {
    // Nothing changed since the two previous runs: the primary takes its cutoff from the run that
    // listed it (not from the --datastore run), so it fetches nobody; Purchases is re-listed in full.
    const r = await sync(config);
    expect(r.status).toBe('completed');
    expect(r.stats.mode).toBe('index');
    const p = r.stats.datastores!['PlayerData']!;
    const q = r.stats.datastores!['Purchases']!;
    expect(p.mode).toBe('index');
    expect(p.checked).toBe(0);
    expect(q.mode).toBe('full');
    expect(q.checked).toBe(purchases.length);
    expect(q.changed).toBe(0);
    expect(r.stats.absent).toBe(0);
  });

  it('index discovery on the supplemental store records absent, not missing, for non-buyers', async () => {
    const entries = await readDataset(dir, 'PlayerData');
    const changed = tickDataset(entries, { fraction: 0.4, seed: 5, now: NOW + 7 * 86400 });
    await writeAll(entries);
    const indexed: PulseConfig = { ...config, game: { ...config.game, datastores: config.game.datastores.map((d) => (d.name === 'Purchases' ? { ...d, sync: { ...d.sync, discovery: 'index' as const } } : d)) } };
    const before = await count(`SELECT count(*) AS n FROM observation WHERE status = 'absent'`);
    const r = await sync(indexed);
    expect(r.status).toBe('completed');
    const p = r.stats.datastores!['PlayerData']!;
    const q = r.stats.datastores!['Purchases']!;
    expect(p.mode).toBe('index');
    expect(p.changed).toBe(changed);
    expect(q.mode).toBe('index');
    expect(q.checked).toBe(p.checked);
    const buyers = new Set(purchases.map((x) => x.userId));
    const activeBuyers = entries.filter((e) => buyers.has(e.userId) && new Date(e.revisionCreateTime).getTime() / 1000 > NOW).length;
    expect(q.unchanged).toBe(activeBuyers);
    expect(q.absent).toBe(p.checked - activeBuyers);
    expect(q.missing).toBe(0);
    expect(r.stats.absent).toBe(q.absent);
    expect(await count(`SELECT count(*) AS n FROM observation WHERE status = 'absent'`)).toBe(before + q.absent);
    // Absent observations never create players.
    expect(await count(`SELECT count(*) AS n FROM player`)).toBe(players);
    // Flush the primary changes so the next test measures the purchase store alone.
    const { a } = await pipeline(config);
    expect(a.versionsCreated).toBe(changed);
    expect(a.playersRebuilt).toBe(0);
  });

  it('a change in the purchase store alone cuts a new version and a stat delta', async () => {
    const entries = await readDataset(dir, 'PlayerData');
    const n = tickPurchases(purchases, entries, { fraction: 1, seed: 6, now: NOW + 8 * 86400 });
    expect(n).toBeGreaterThan(0);
    await writeDataset(dir, 'Purchases', purchases);
    const versionsBefore = await count('SELECT count(*) AS n FROM profile_version');
    const r = await sync(config, { datastores: ['Purchases'] });
    expect(r.stats.datastores!['Purchases']!.changed).toBe(n);
    const { a } = await pipeline(config);
    // Each changed purchase snapshot adds exactly one version to its player's sequence, whether it
    // lands at the end or interleaves earlier (which rebuilds that player's later versions), except
    // when it was written before the player's first primary snapshot: then it is carried into
    // version 1 and replaces the earlier purchase state there.
    expect(a.versionsCreated).toBeGreaterThanOrEqual(n);
    const carried = await count(
      `SELECT count(*) AS n FROM snapshot s
        WHERE s.datastore = 'Purchases' AND s.sync_run_id = (SELECT max(id) FROM sync_run)
          AND s.revision_created_at < (SELECT min(p.revision_created_at) FROM snapshot p WHERE p.user_id = s.user_id AND p.datastore = 'PlayerData')`,
    );
    expect(await count('SELECT count(*) AS n FROM profile_version')).toBe(versionsBefore + n - carried);
    // Carried snapshots are the purchase component of that player's version 1.
    expect(
      await count(
        `SELECT count(*) AS n FROM snapshot s JOIN profile_version pv ON pv.user_id = s.user_id AND pv.version_no = 1
          WHERE s.datastore = 'Purchases' AND s.sync_run_id = (SELECT max(id) FROM sync_run)
            AND s.revision_created_at < (SELECT min(p.revision_created_at) FROM snapshot p WHERE p.user_id = s.user_id AND p.datastore = 'PlayerData')
            AND (pv.components->>'Purchases')::bigint = s.id`,
      ),
    ).toBe(carried);
    expect(await count(`SELECT count(*) AS n FROM stat_delta WHERE key = 'purchase_count' AND delta > 0`)).toBeGreaterThan(0);
  });

  it('backfill skips a store with sync.backfill: false', async () => {
    const limiter = new RateLimiter({ maxPerMinute: 60_000, budgetFraction: 1 });
    const client = new OpenCloudClient({ baseUrl: config.game.baseUrl, apiKey: 'demo-key', universeId: '1', limiter });
    const before = await count(`SELECT count(*) AS n FROM snapshot WHERE datastore = 'Purchases'`);
    await backfillRevisions(pool, config, client, log, { days: 3650, maxRevisions: 5 });
    expect(await count(`SELECT count(*) AS n FROM snapshot WHERE datastore = 'Purchases'`)).toBe(before);
  });
});
