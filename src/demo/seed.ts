/**
 * Turn-key demo: build a synthetic game world, replay N weekly syncs of it through the
 * whole pipeline into a dedicated demo database, and enrich the players. Everything
 * runs in-process (the mock Open Cloud server is started on an ephemeral port), and the
 * target must be a database whose name says "demo", so a real tenant is never touched.
 */
import { loadConfig } from '../config/load.js';
import type { PulseConfig } from '../config/schema.js';
import { createPool, databaseName, dropAllObjects, ensureDatabase } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { applyViews, assembleProfiles, deriveProfiles, extractProfiles } from '../profile/index.js';
import { OpenCloudClient, RateLimiter, SyncStore, enrichPlayers, runSync, type Logger } from '../sync/index.js';
import { lastLoginIndex, writeDataset, writeOrderedIndex } from './dataset.js';
import { generateDataset, generatePurchases, tickDataset, tickPurchases, type DemoEntry } from './generate.js';
import { MockOpenCloud } from './mock-open-cloud.js';

export interface SeedOptions {
  /** The demo database. Its name must contain "demo" unless `force` is set. */
  databaseUrl: string;
  /** A connection on the same server used to create the demo database if it is missing. */
  adminUrl: string;
  players: number;
  seed: number;
  /** Weekly syncs to replay after the initial one. */
  weeks: number;
  /** Share of players who return and play each week. */
  fraction: number;
  /** Where the JSONL datasets are written (the mock server serves them from here). */
  dataDir: string;
  /** The demo game's config directory. */
  configDir: string;
  log: Logger;
  /** Unix seconds for the end of the replayed history; defaults to now. */
  now?: number;
  force?: boolean;
}

export interface SeedStats {
  database: string;
  created: boolean;
  players: number;
  purchasers: number;
  runs: number;
  snapshots: number;
  versions: number;
  facts: number;
  events: number;
  milestoneEvents: number;
  enriched: number;
  firstRunAt: Date;
  lastRunAt: Date;
}

const DAY = 86_400;
const WEEK = 7 * DAY;
const quiet: Logger = { info: () => {}, warn: () => {} };

export async function seedDemo(opts: SeedOptions): Promise<SeedStats> {
  const { log } = opts;
  const dbName = databaseName(opts.databaseUrl);
  if (!/demo/i.test(dbName) && !opts.force) {
    throw new Error(`refusing to reset database "${dbName}": the demo only writes to a database with "demo" in its name (pass --force to override)`);
  }
  const created = await ensureDatabase(opts.adminUrl, dbName);
  log.info(`${created ? 'created' : 'using'} database ${dbName}`);

  const demo = await loadConfig(opts.configDir);
  const primary = demo.game.datastores[0]!;
  const purchaseStore = demo.game.datastores[1];
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const start = now - (opts.weeks + 1) * WEEK;

  const players = generateDataset({ players: opts.players, seed: opts.seed, now: start, keyTemplate: primary.keyTemplate, envelope: primary.envelope });
  const purchases: DemoEntry[] = purchaseStore ? generatePurchases(players, { seed: opts.seed + 1, keyTemplate: purchaseStore.keyTemplate }) : [];
  const writeWorld = async (): Promise<void> => {
    await writeDataset(opts.dataDir, primary.name, players);
    await writeOrderedIndex(opts.dataDir, demo.game.sync.index?.orderedDatastore ?? 'LastLogin', lastLoginIndex(players));
    if (purchaseStore) await writeDataset(opts.dataDir, purchaseStore.name, purchases);
  };
  await writeWorld();
  log.info(`generated ${players.length} players (${purchases.length} with purchases); history starts ${new Date(start * 1000).toISOString().slice(0, 10)}`);

  const pool = createPool(opts.databaseUrl);
  const mock = new MockOpenCloud({ dataDir: opts.dataDir, universeId: demo.game.universeId, apiKey: 'demo-key', rpm: 10_000_000 });
  try {
    await dropAllObjects(pool);
    await migrate(pool);
    const port = await mock.listen(0);
    const config: PulseConfig = { ...demo, game: { ...demo.game, baseUrl: `http://localhost:${port}` } };
    const store = new SyncStore(pool);

    for (let week = 0; week <= opts.weeks; week++) {
      const weekStart = start + week * WEEK;
      if (week > 0) {
        const changed = tickDataset(players, { fraction: opts.fraction, seed: opts.seed + 100 + week, now: weekStart });
        const bought = purchaseStore ? tickPurchases(purchases, players, { fraction: opts.fraction, seed: opts.seed + 200 + week, now: weekStart, keyTemplate: purchaseStore.keyTemplate }) : 0;
        await writeWorld();
        mock.invalidate();
        log.info(`week ${week}: ${changed} players played, ${bought} purchase records changed`);
      }
      // The scheduled job runs at the end of the week, after that week's play.
      const runAt = new Date((weekStart + WEEK - 3600) * 1000);
      const limiter = new RateLimiter({ maxPerMinute: 1_000_000, budgetFraction: 1 });
      const client = new OpenCloudClient({ baseUrl: config.game.baseUrl, apiKey: 'demo-key', universeId: config.game.universeId, limiter });
      const r = await runSync({ config, store, client, limiter, log: quiet, ignoreWindow: true, fresh: true, clock: () => runAt });
      if (r.status !== 'completed') throw new Error(`demo sync for week ${week} ended ${r.status}`);
      const a = await assembleProfiles(pool, quiet, { primary: primary.name });
      const e = await extractProfiles(pool, config, quiet);
      const d = await deriveProfiles(pool, config, quiet);
      await applyViews(pool, config);
      for (const [k, m] of Object.entries(e.errors)) log.warn(`${k}: ${m}`);
      log.info(`  sync ${runAt.toISOString().slice(0, 10)}: ${r.stats.changed} changed, ${a.versionsCreated} versions, ${e.factsWritten} facts, ${d.eventsCreated} milestone/flag events`);
    }

    const limiter = new RateLimiter({ maxPerMinute: 1_000_000, budgetFraction: 1 });
    const client = new OpenCloudClient({ baseUrl: config.game.baseUrl, apiKey: 'demo-key', universeId: config.game.universeId, limiter });
    const en = await enrichPlayers(pool, client, quiet, { refreshDays: 0 });

    const one = async (sql: string): Promise<number> => Number((await pool.query(sql)).rows[0].n);
    const runs = await pool.query<{ n: string; first: Date; last: Date }>('SELECT count(*) AS n, min(started_at) AS first, max(started_at) AS last FROM sync_run');
    return {
      database: dbName,
      created,
      players: await one('SELECT count(*) AS n FROM player'),
      purchasers: purchases.length,
      runs: Number(runs.rows[0]!.n),
      snapshots: await one('SELECT count(*) AS n FROM snapshot'),
      versions: await one('SELECT count(*) AS n FROM profile_version'),
      facts: await one('SELECT count(*) AS n FROM fact'),
      events: await one('SELECT count(*) AS n FROM event'),
      milestoneEvents: await one('SELECT count(*) AS n FROM milestone_event'),
      enriched: en.updated,
      firstRunAt: runs.rows[0]!.first,
      lastRunAt: runs.rows[0]!.last,
    };
  } finally {
    await mock.close();
    await pool.end();
  }
}
