#!/usr/bin/env node
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, resolveConfigDir, ConfigError } from './config/load.js';
import { evaluate } from './expr/engine.js';
import { detectEnvelope } from './envelope/index.js';
import { createPool, demoDatabaseUrl, withDatabaseName } from './db/client.js';
import { seedDemo } from './demo/seed.js';
import { migrate } from './db/migrate.js';
import { generateDataset, tickDataset, generatePurchases, tickPurchases } from './demo/generate.js';
import { readDataset, writeDataset } from './demo/dataset.js';
import { MockOpenCloud } from './demo/mock-open-cloud.js';
import { OpenCloudClient, RateLimiter, SyncStore, runSync, backfillRevisions, enrichPlayers } from './sync/index.js';
import { writeOrderedIndex, lastLoginIndex } from './demo/dataset.js';
import { assembleProfiles, extractProfiles, applyViews, deriveProfiles, composeDocument, type StorePart } from './profile/index.js';
import { storeAlias, type DatastoreConfig, type PulseConfig } from './config/schema.js';
import { configJsonSchemas } from './config/json-schema.js';

const program = new Command();
program.name('pulse').description('Config-driven analytics for Roblox DataStore records').version('0.1.0');

function fail(err: unknown): never {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------- config
const config = program.command('config').description('Validate and inspect configuration');

config
  .command('validate')
  .description('Load the config directory and report every problem found')
  .option('-c, --config <dir>', 'config directory (default: $PULSE_CONFIG_DIR or ./config)')
  .action(async (opts: { config?: string }) => {
    const dir = resolveConfigDir(opts.config);
    try {
      const cfg = await loadConfig(dir);
      console.log(`ok: ${dir}`);
      console.log(`  universe ${cfg.game.universeId}, ${cfg.game.datastores.length} datastore(s): ${cfg.game.datastores.map((d) => d.name).join(', ')}`);
      console.log(`  ${cfg.facts.length} facts, ${cfg.milestones.length} milestones, ${cfg.flags.length} flags, ${cfg.segments.length} segments`);
    } catch (err) {
      fail(err);
    }
  });

config
  .command('schema')
  .description('Write JSON Schema files for the config YAML (editor validation and autocomplete)')
  .option('-o, --out <dir>', 'output directory', 'schema')
  .action(async (o: { out: string }) => {
    const { mkdir } = await import('node:fs/promises');
    const dir = path.resolve(o.out);
    await mkdir(dir, { recursive: true });
    for (const [name, json] of Object.entries(configJsonSchemas())) {
      await writeFile(path.join(dir, name), JSON.stringify(json, null, 2) + '\n', 'utf8');
    }
    console.log(`wrote ${Object.keys(configJsonSchemas()).length} schema files to ${dir}`);
  });

config
  .command('apply')
  .description('(Re)generate the wide SQL views (v_player_current, v_player_history) for the current facts')
  .option('-c, --config <dir>', 'config directory')
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (o: { config?: string; databaseUrl?: string }) => {
    const pool = createPool(o.databaseUrl);
    try {
      const cfg = await loadConfig(resolveConfigDir(o.config));
      const r = await applyViews(pool, cfg);
      console.log(`views ${r.changed ? 'regenerated' : 'unchanged'} for facts config ${r.hash} (${cfg.facts.filter((f) => f.shape === 'scalar').length} scalar columns)`);
    } catch (err) {
      fail(err);
    } finally {
      await pool.end();
    }
  });

// ---------------------------------------------------------------- extract
program
  .command('extract')
  .description('Assemble profile versions from snapshots and extract facts defined in config')
  .option('-c, --config <dir>', 'config directory')
  .option('--rebuild', 'drop and rebuild all profile versions and facts (events are kept)', false)
  .option('--user <id>', 'only this player')
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (o: { config?: string; rebuild: boolean; user?: string; databaseUrl?: string }) => {
    const pool = createPool(o.databaseUrl);
    try {
      const cfg = await loadConfig(resolveConfigDir(o.config));
      await extractPipeline(pool, cfg, { rebuild: o.rebuild, userId: o.user ? Number(o.user) : undefined });
    } catch (err) {
      fail(err);
    } finally {
      await pool.end();
    }
  });

program
  .command('derive')
  .description('Recompute milestone/flag events and stat deltas from existing facts (extract does this too)')
  .option('-c, --config <dir>', 'config directory')
  .option('--rebuild', 'recompute for every profile version', false)
  .option('--user <id>', 'only this player')
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (o: { config?: string; rebuild: boolean; user?: string; databaseUrl?: string }) => {
    const pool = createPool(o.databaseUrl);
    try {
      const cfg = await loadConfig(resolveConfigDir(o.config));
      const d = await deriveProfiles(pool, cfg, logger, { userId: o.user ? Number(o.user) : undefined, rebuild: o.rebuild });
      logger.info(`derive: ${d.playersProcessed} players, ${d.versionsProcessed} versions, ${d.eventsCreated} events, ${d.deltasWritten} deltas`);
    } catch (err) {
      fail(err);
    } finally {
      await pool.end();
    }
  });

program
  .command('export')
  .description('Export a view, table, or query to CSV')
  .option('--view <name>', 'view or table to export', 'v_player_current')
  .option('--sql <query>', 'a SELECT to export instead of --view')
  .option('-o, --out <file>', 'output file (default: <view>.csv)')
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (o: { view: string; sql?: string; out?: string; databaseUrl?: string }) => {
    const pool = createPool(o.databaseUrl);
    try {
      if (!o.sql && !/^[a-z_][a-z0-9_]*$/i.test(o.view)) fail(new Error('invalid view name'));
      const sql = o.sql ?? `SELECT * FROM "${o.view}"`;
      if (!/^\s*(select|with)\b/i.test(sql)) fail(new Error('only SELECT queries can be exported'));
      const r = await pool.query(sql);
      const cols = r.fields.map((f) => f.name);
      const cell = (v: unknown): string => {
        if (v === null || v === undefined) return '';
        const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [cols.map(cell).join(',')];
      for (const row of r.rows as Record<string, unknown>[]) lines.push(cols.map((c) => cell(row[c])).join(','));
      const out = path.resolve(o.out ?? `${o.sql ? 'export' : o.view}.csv`);
      await writeFile(out, lines.join('\n') + '\n', 'utf8');
      console.log(`wrote ${r.rows.length} rows, ${cols.length} columns to ${out}`);
    } catch (err) {
      fail(err);
    } finally {
      await pool.end();
    }
  });

program
  .command('facts <userId>')
  .description("Show a player's current facts")
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (userId: string, o: { databaseUrl?: string }) => {
    const pool = createPool(o.databaseUrl);
    try {
      const pv = await pool.query<{ id: number; version_no: number; valid_from: Date }>(
        'SELECT id, version_no, valid_from FROM profile_version WHERE user_id = $1 AND valid_to IS NULL',
        [Number(userId)],
      );
      if (!pv.rows[0]) {
        console.log(`no profile for user ${userId} (run pulse sync, then pulse extract)`);
        return;
      }
      console.log(`user ${userId}: profile version ${pv.rows[0].version_no} since ${pv.rows[0].valid_from.toISOString()}`);
      const rows = await pool.query<{ key: string; dim: string; kind: string; num: number | null; bool: boolean | null; text: string | null; ts: Date | null }>(
        'SELECT key, dim, kind, num, bool, text, ts FROM fact WHERE profile_version_id = $1 ORDER BY key, dim',
        [pv.rows[0].id],
      );
      for (const r of rows.rows) {
        const v = r.num ?? r.bool ?? r.text ?? r.ts?.toISOString() ?? '';
        console.log(`  ${r.key}${r.dim ? `[${r.dim}]` : ''} (${r.kind}) = ${String(v)}`);
      }
      const ev = await pool.query<{ n: string }>('SELECT count(*) AS n FROM event WHERE user_id = $1', [Number(userId)]);
      console.log(`  events harvested: ${ev.rows[0]?.n ?? 0}`);
      const seg = await pool.query<{ key: string; member: boolean; label: string | null }>('SELECT key, member, label FROM segment_membership WHERE profile_version_id = $1 ORDER BY key', [pv.rows[0].id]);
      if (seg.rows.length) console.log('segments:');
      for (const s of seg.rows) console.log(`  ${s.key} = ${s.label ?? String(s.member)}`);
      const ms = await pool.query<{ key: string; kind: string; reached_lo: Date | null; reached_hi: Date; precision: string }>(
        'SELECT key, kind, reached_lo, reached_hi, precision FROM milestone_event WHERE user_id = $1 ORDER BY kind, ordinal',
        [Number(userId)],
      );
      if (ms.rows.length) console.log('milestones and flags:');
      for (const m of ms.rows) {
        const when = m.precision === 'exact' ? m.reached_hi.toISOString() : `${m.reached_lo?.toISOString() ?? '?'} .. ${m.reached_hi.toISOString()}`;
        console.log(`  ${m.kind} ${m.key}: ${when} (${m.precision})`);
      }
      const sd = await pool.query<{ key: string; dim: string; delta: number; per_day: number; to_at: Date; reset: boolean }>(
        'SELECT key, dim, delta, per_day, to_at, reset FROM stat_delta WHERE user_id = $1 AND to_version_id = $2 ORDER BY key, dim',
        [Number(userId), pv.rows[0].id],
      );
      if (sd.rows.length) console.log('change since previous version:');
      for (const r of sd.rows) {
        const sign = r.delta > 0 ? '+' : '';
        console.log(`  ${r.key}${r.dim ? `[${r.dim}]` : ''}: ${sign}${r.delta} (${r.per_day.toFixed(2)}/day)${r.reset ? ' RESET' : ''}`);
      }
    } catch (err) {
      fail(err);
    } finally {
      await pool.end();
    }
  });

// ---------------------------------------------------------------- eval
program
  .command('eval <expr>')
  .description('Evaluate a JSONata expression against a record file (learning and debugging tool)')
  .requiredOption('-r, --record <file>', "JSON file containing the primary datastore's stored value")
  .option('-s, --store <alias=file...>', 'supplemental store values, mounted as in game.yaml (or at <alias> when no datastore matches)')
  .option('-c, --config <dir>', 'config directory; makes constants.yaml available as $name bindings and resolves --store mounts')
  .option('--raw', 'do not unwrap a wrapper-library envelope', false)
  .option('--json', 'print result as compact JSON', false)
  .action(async (expr: string, opts: { record: string; store?: string[]; config?: string; raw: boolean; json: boolean }) => {
    try {
      let cfg: PulseConfig | undefined;
      if (opts.config || process.env.PULSE_CONFIG_DIR) {
        try {
          cfg = await loadConfig(resolveConfigDir(opts.config));
        } catch (err) {
          if (opts.config) throw err;
        }
      }
      // A whole expression that is one quoted string literal is never useful; it means the
      // shell passed the quotes through (cmd.exe does this with single quotes).
      const lit = /^(['"])((?:(?!).)*)$/s.exec(expr.trim());
      if (lit && lit[2]) {
        console.error(`hint: the expression arrived as a quoted string literal (${expr.trim()}), so the result below is just that text.`);
        console.error(`      On cmd.exe wrap the expression in double quotes; in PowerShell or bash use single quotes.`);
      }
      const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(path.resolve(file), 'utf8')) as unknown;
      const primaryValue = await readJson(opts.record);

      // The datastore list to compose with: the configured one, or one made up from the files given.
      const configured = cfg?.game.datastores ?? [];
      const synthetic = (name: string, body: unknown, mount?: string): DatastoreConfig => ({ name, scope: 'global', keyTemplate: '{userId}', envelope: detectEnvelope(body), mount, sync: { backfill: true } });
      const primaryDs = configured[0] ?? synthetic('record', primaryValue);
      const datastores: DatastoreConfig[] = [opts.raw ? { ...primaryDs, envelope: 'raw' } : primaryDs];
      const parts = new Map<string, StorePart>([[primaryDs.name, { body: primaryValue }]]);
      for (const spec of opts.store ?? []) {
        const eq = spec.indexOf('=');
        if (eq <= 0) throw new Error(`--store expects alias=file, got "${spec}"`);
        const alias = spec.slice(0, eq);
        const body = await readJson(spec.slice(eq + 1));
        const ds = configured.find((d) => d.name === alias || storeAlias(d) === alias || d.mount === alias);
        if (ds && ds === configured[0]) throw new Error(`"${alias}" is the primary datastore; pass its file with --record`);
        if (ds) {
          datastores.push(ds);
          parts.set(ds.name, { body });
        } else {
          if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(alias)) throw new Error(`no datastore "${alias}" in game.yaml, and it is not a valid mount path`);
          datastores.push(synthetic(alias, body, alias));
          parts.set(alias, { body });
        }
      }
      const doc = composeDocument({ constants: cfg?.constants ?? {}, game: { datastores } }, parts);
      for (const w of Object.values(doc.warnings)) console.error(`warning: ${w}`);
      const result = await evaluate(expr, doc.data, doc.bindings);
      if (result === undefined) console.log('(undefined)');
      else console.log(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- db
const db = program.command('db').description('Database maintenance');

db.command('migrate')
  .description('Create the schema in an empty database, or apply pending release migrations (see db/README.md)')
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (opts: { databaseUrl?: string }) => {
    const pool = createPool(opts.databaseUrl);
    try {
      const r = await migrate(pool);
      if (r.bootstrapped) console.log('pre-release database recognised and re-labelled as schema 0.1.0');
      if (r.baseline) console.log(`empty database: loaded db/schema.sql (${r.baseline})`);
      if (r.applied.length) console.log(`applied: ${r.applied.join(', ')}`);
      if (r.reapplied.length) console.log(`re-applied (head migration changed): ${r.reapplied.join(', ')}`);
      if (!r.baseline && !r.applied.length && !r.reapplied.length) console.log(`up to date${r.skipped.length ? ` (${r.skipped.length} migration${r.skipped.length === 1 ? '' : 's'} already applied)` : ''}`);
    } catch (err) {
      fail(err);
    } finally {
      await pool.end();
    }
  });

// ---------------------------------------------------------------- sync
const stamp = (): string => new Date().toISOString().slice(11, 19);
const logger = {
  info: (m: string) => console.error(`${stamp()} ${m}`),
  warn: (m: string) => console.error(`${stamp()} warn: ${m}`),
};

program
  .command('sync')
  .description('Pull every player record via Open Cloud into local snapshots (resumable)')
  .option('-c, --config <dir>', 'config directory (default: $PULSE_CONFIG_DIR or ./config)')
  .option('--fresh', 'start a new run instead of resuming a paused one', false)
  .option('--full', 'list every key even when a last-login index is configured', false)
  .option('--limit <n>', 'stop after n keys per datastore and leave the run paused (testing)')
  .option('--datastore <name...>', 'only sync these datastores')
  .option('--ignore-window', 'ignore the configured time-of-day window', false)
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (o: { config?: string; fresh: boolean; full: boolean; limit?: string; datastore?: string[]; ignoreWindow: boolean; databaseUrl?: string }) => {
    const ctx = await openCloudContext(o.config, o.databaseUrl);
    try {
      const result = await runSync({
        config: ctx.cfg,
        store: new SyncStore(ctx.pool),
        client: ctx.client,
        limiter: ctx.limiter,
        log: logger,
        fresh: o.fresh,
        full: o.full,
        limit: o.limit ? Number(o.limit) : undefined,
        datastores: o.datastore,
        signal: ctx.signal,
        ignoreWindow: o.ignoreWindow,
      });
      process.exitCode = result.status === 'completed' ? 0 : 2;
    } catch (err) {
      fail(err);
    } finally {
      await ctx.pool.end();
    }
  });

/** Shared setup for commands that talk to Open Cloud: config, API key, pool, pacing, Ctrl-C. */
async function openCloudContext(configDir: string | undefined, databaseUrl: string | undefined) {
  let cfg;
  try {
    cfg = await loadConfig(resolveConfigDir(configDir));
  } catch (err) {
    fail(err);
  }
  const apiKey = process.env[cfg.game.apiKeyEnv];
  if (!apiKey) fail(new Error(`environment variable ${cfg.game.apiKeyEnv} is not set (see game.yaml apiKeyEnv)`));
  const pool = createPool(databaseUrl);
  const limiter = new RateLimiter({ maxPerMinute: cfg.game.sync.maxRequestsPerMinute, budgetFraction: cfg.game.sync.budgetFraction });
  const client = new OpenCloudClient({ baseUrl: cfg.game.baseUrl, apiKey, universeId: cfg.game.universeId, limiter, log: logger.info });
  const controller = new AbortController();
  const onSignal = () => {
    logger.info('interrupt received; stopping after the current item (run again to resume)');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return { cfg, pool, limiter, client, signal: controller.signal };
}

async function extractPipeline(pool: ReturnType<typeof createPool>, cfg: Awaited<ReturnType<typeof loadConfig>>, opts: { rebuild?: boolean; userId?: number } = {}): Promise<void> {
  const a = await assembleProfiles(pool, logger, { rebuild: opts.rebuild, userId: opts.userId, primary: cfg.game.datastores[0]!.name });
  logger.info(`assemble: ${a.playersExamined} players examined, ${a.versionsCreated} versions created, ${a.playersRebuilt} rebuilt`);
  const e = await extractProfiles(pool, cfg, logger, { userId: opts.userId });
  logger.info(`extract: ${e.versionsExtracted} versions, ${e.factsWritten} facts, ${e.segmentsWritten} segment rows, ${e.eventsWritten} new events, ${Object.keys(e.errors).length} definitions with errors`);
  const d = await deriveProfiles(pool, cfg, logger, { userId: opts.userId, rebuild: opts.rebuild });
  logger.info(`derive: ${d.playersProcessed} players, ${d.eventsCreated} milestone/flag events, ${d.deltasWritten} stat deltas`);
  const v = await applyViews(pool, cfg);
  if (v.changed) logger.info('views regenerated');
}

program
  .command('run')
  .description('The scheduled job: sync, then extract/derive, then enrich new players')
  .option('-c, --config <dir>', 'config directory')
  .option('--fresh', 'start a new sync run instead of resuming a paused one', false)
  .option('--full', 'list every key even when a last-login index is configured', false)
  .option('--skip-sync', 'only run the extract pipeline', false)
  .option('--no-enrich', 'skip users API enrichment of new players')
  .option('--ignore-window', 'ignore the configured time-of-day window', false)
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (o: { config?: string; fresh: boolean; full: boolean; skipSync: boolean; enrich: boolean; ignoreWindow: boolean; databaseUrl?: string }) => {
    const ctx = await openCloudContext(o.config, o.databaseUrl);
    try {
      if (!o.skipSync) {
        const r = await runSync({ config: ctx.cfg, store: new SyncStore(ctx.pool), client: ctx.client, limiter: ctx.limiter, log: logger, fresh: o.fresh, full: o.full, signal: ctx.signal, ignoreWindow: o.ignoreWindow });
        if (r.status !== 'completed') {
          logger.info(`sync ${r.status}; extract will run on the next completed sync`);
          process.exitCode = 2;
          return;
        }
      }
      await extractPipeline(ctx.pool, ctx.cfg);
      if (o.enrich && !ctx.signal.aborted) {
        const en = await enrichPlayers(ctx.pool, ctx.client, logger, { refreshDays: 0, signal: ctx.signal });
        logger.info(`enrich: ${en.attempted} players, ${en.updated} updated, ${en.missing} not found, ${en.errors} errors`);
      }
    } catch (err) {
      fail(err);
    } finally {
      await ctx.pool.end();
    }
  });

program
  .command('backfill')
  .description('Reconstruct earlier snapshots from Open Cloud revision history (about 30 days), then extract')
  .option('-c, --config <dir>', 'config directory')
  .option('--days <n>', 'how far back', '30')
  .option('--max-revisions <n>', 'per player and datastore', '50')
  .option('--user <id>', 'only this player')
  .option('--no-extract', 'do not run the extract pipeline afterwards')
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (o: { config?: string; days: string; maxRevisions: string; user?: string; extract: boolean; databaseUrl?: string }) => {
    const ctx = await openCloudContext(o.config, o.databaseUrl);
    try {
      const userId = o.user ? Number(o.user) : undefined;
      const b = await backfillRevisions(ctx.pool, ctx.cfg, ctx.client, logger, { days: Number(o.days), maxRevisions: Number(o.maxRevisions), userId, signal: ctx.signal });
      logger.info(`backfill: ${b.playersConsidered} players, ${b.revisionsListed} revisions listed, ${b.revisionsFetched} fetched, ${b.snapshotsInserted} snapshots added, ${b.errors} errors`);
      if (o.extract && b.snapshotsInserted > 0) await extractPipeline(ctx.pool, ctx.cfg, { userId });
    } catch (err) {
      fail(err);
    } finally {
      await ctx.pool.end();
    }
  });

program
  .command('enrich')
  .description('Fetch username, display name, account age, locale and premium status from the users API')
  .option('-c, --config <dir>', 'config directory')
  .option('--refresh-days <n>', 'also refresh players enriched longer ago than this (0 = new players only)', '0')
  .option('--max <n>', 'stop after n players')
  .option('--user <id>', 'only this player')
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (o: { config?: string; refreshDays: string; max?: string; user?: string; databaseUrl?: string }) => {
    const ctx = await openCloudContext(o.config, o.databaseUrl);
    try {
      const en = await enrichPlayers(ctx.pool, ctx.client, logger, { refreshDays: Number(o.refreshDays), max: o.max ? Number(o.max) : undefined, userId: o.user ? Number(o.user) : undefined, signal: ctx.signal });
      logger.info(`enrich: ${en.attempted} players, ${en.updated} updated, ${en.missing} not found, ${en.errors} errors`);
    } catch (err) {
      fail(err);
    } finally {
      await ctx.pool.end();
    }
  });

program
  .command('runs')
  .description('List recent sync runs')
  .option('-n, --limit <n>', 'how many', '20')
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (o: { limit: string; databaseUrl?: string }) => {
    const pool = createPool(o.databaseUrl);
    try {
      const runs = await new SyncStore(pool).listRuns(Number(o.limit));
      if (!runs.length) console.log('no runs yet');
      for (const r of runs) {
        const s = r.stats;
        console.log(
          `#${r.id}  ${r.status.padEnd(9)} ${r.started_at.toISOString()}  ${(s.mode ?? 'full').padEnd(5)}  checked ${s.checked ?? 0}  changed ${s.changed ?? 0}  missing ${s.missing ?? 0}  ` +
            `absent ${s.absent ?? 0}  errors ${s.errors ?? 0}  requests ${s.requests ?? 0}  throttled ${s.throttled ?? 0}  ${(((s.elapsedMs ?? 0) / 1000) | 0)}s`,
        );
        for (const [name, d] of Object.entries(s.datastores ?? {})) {
          if (Object.keys(s.datastores ?? {}).length > 1) console.log(`      ${name} (${d.mode ?? 'full'}): listed ${d.listed}  checked ${d.checked}  changed ${d.changed}  missing ${d.missing}  absent ${d.absent}`);
        }
      }
    } catch (err) {
      fail(err);
    } finally {
      await pool.end();
    }
  });

program
  .command('purge <userId>')
  .description('Delete every stored trace of a player (snapshots, observations, derived data)')
  .option('--yes', 'do not ask for confirmation', false)
  .option('--database-url <url>', 'overrides DATABASE_URL')
  .action(async (userId: string, o: { yes: boolean; databaseUrl?: string }) => {
    if (!/^\d+$/.test(userId)) fail(new Error('userId must be numeric'));
    if (!o.yes) fail(new Error('refusing to purge without --yes'));
    const pool = createPool(o.databaseUrl);
    try {
      const r = await new SyncStore(pool).purge(Number(userId));
      console.log(`purged user ${userId}: ${r.snapshots} snapshots, ${r.observations} observations, ${r.player} player row`);
    } catch (err) {
      fail(err);
    } finally {
      await pool.end();
    }
  });

// ---------------------------------------------------------------- demo
const demo = program.command('demo').description('Synthetic demo game and mock Open Cloud server');
const DEMO_DIR = 'examples/demo-game/data';
const DEMO_CONFIG = 'examples/demo-game/config';

demo
  .command('seed')
  .description('Turn-key demo: generate a game world and replay weekly syncs of it into the demo database (never the real one)')
  .option('-n, --players <n>', 'number of players', '500')
  .option('-w, --weeks <n>', 'weekly syncs to replay after the first', '8')
  .option('-f, --fraction <f>', 'share of players who return each week', '0.3')
  .option('-s, --seed <n>', 'random seed', '42')
  .option('-d, --data <dir>', 'dataset directory', DEMO_DIR)
  .option('-c, --config <dir>', 'demo config directory', DEMO_CONFIG)
  .option('--database-url <url>', 'demo database (default: $PULSE_DEMO_DATABASE_URL, else $DATABASE_URL with database pulse_demo)')
  .option('--force', 'allow a database whose name does not contain "demo"', false)
  .action(async (o: { players: string; weeks: string; fraction: string; seed: string; data: string; config: string; databaseUrl?: string; force: boolean }) => {
    try {
      const databaseUrl = o.databaseUrl ?? demoDatabaseUrl();
      if (!databaseUrl) fail(new Error('set DATABASE_URL or PULSE_DEMO_DATABASE_URL (see .env.example), or pass --database-url'));
      const adminUrl = process.env.DATABASE_URL ?? withDatabaseName(databaseUrl, 'postgres');
      const s = await seedDemo({
        databaseUrl,
        adminUrl,
        players: Number(o.players),
        weeks: Number(o.weeks),
        fraction: Number(o.fraction),
        seed: Number(o.seed),
        dataDir: path.resolve(o.data),
        configDir: path.resolve(o.config),
        log: logger,
        force: o.force,
      });
      const grafana = `http://localhost:${process.env.PULSE_GRAFANA_PORT ?? '3000'}`;
      console.log(
        `\nDemo ready in database ${s.database}: ${s.players} players (${s.purchasers} with purchases), ${s.runs} weekly syncs from ${s.firstRunAt.toISOString().slice(0, 10)} to ${s.lastRunAt.toISOString().slice(0, 10)},\n` +
          `${s.snapshots} snapshots, ${s.versions} profile versions, ${s.facts} facts, ${s.events} events, ${s.milestoneEvents} milestone/flag events, ${s.enriched} players enriched.\n\n` +
          `Open ${grafana} (admin / ${process.env.GRAFANA_ADMIN_PASSWORD ?? 'pulse'}), folder "Pulse", and set the Database dropdown to "pulse-demo".\n` +
          `Any pulse command can inspect it with --database-url ${databaseUrl}\n` +
          `Your real data in DATABASE_URL was not touched.`,
      );
    } catch (err) {
      fail(err);
    }
  });

demo
  .command('generate')
  .description('Generate a synthetic dataset')
  .option('-n, --players <n>', 'number of players', '500')
  .option('-s, --seed <n>', 'random seed', '42')
  .option('-o, --out <dir>', 'output directory', DEMO_DIR)
  .option('--datastore <name>', 'datastore name', 'PlayerData')
  .option('--key-template <t>', 'key template', 'Player_{userId}')
  .option('--envelope <preset>', 'raw | documentservice', 'documentservice')
  .option('--purchases <name>', 'name of the sparse supplemental purchase store', 'Purchases')
  .option('--purchase-fraction <f>', 'share of players with a purchase record', '0.05')
  .option('--now <unix>', 'unix seconds for "now"', String(Math.floor(Date.now() / 1000)))
  .action(async (o: { players: string; seed: string; out: string; datastore: string; keyTemplate: string; envelope: 'raw' | 'documentservice'; purchases: string; purchaseFraction: string; now: string }) => {
    const entries = generateDataset({ players: Number(o.players), seed: Number(o.seed), now: Number(o.now), keyTemplate: o.keyTemplate, envelope: o.envelope });
    const file = await writeDataset(path.resolve(o.out), o.datastore, entries);
    const idx = await writeOrderedIndex(path.resolve(o.out), 'LastLogin', lastLoginIndex(entries));
    const purchases = generatePurchases(entries, { seed: Number(o.seed) + 1, fraction: Number(o.purchaseFraction) });
    const pfile = await writeDataset(path.resolve(o.out), o.purchases, purchases);
    console.log(`wrote ${entries.length} entries to ${file}\nwrote last-login index to ${idx}\nwrote ${purchases.length} purchase records to ${pfile}`);
  });

demo
  .command('tick')
  .description('Advance the demo world: a fraction of players return and change')
  .option('-f, --fraction <f>', 'share of players that change', '0.1')
  .option('-s, --seed <n>', 'random seed', String(Date.now() % 100000))
  .option('-d, --data <dir>', 'dataset directory', DEMO_DIR)
  .option('--datastore <name>', 'datastore name', 'PlayerData')
  .option('--purchases <name>', 'name of the supplemental purchase store (skipped if its dataset does not exist)', 'Purchases')
  .option('--now <unix>', 'unix seconds for "now"', String(Math.floor(Date.now() / 1000)))
  .action(async (o: { fraction: string; seed: string; data: string; datastore: string; purchases: string; now: string }) => {
    try {
      const entries = await readDataset(path.resolve(o.data), o.datastore);
      const changed = tickDataset(entries, { fraction: Number(o.fraction), seed: Number(o.seed), now: Number(o.now) });
      await writeDataset(path.resolve(o.data), o.datastore, entries);
      await writeOrderedIndex(path.resolve(o.data), 'LastLogin', lastLoginIndex(entries));
      let purchaseNote = '';
      const purchases = await readDataset(path.resolve(o.data), o.purchases).catch(() => undefined);
      if (purchases) {
        const n = tickPurchases(purchases, entries, { fraction: Number(o.fraction), seed: Number(o.seed) + 1, now: Number(o.now) });
        await writeDataset(path.resolve(o.data), o.purchases, purchases);
        purchaseNote = `; ${n} purchase records changed or added`;
      }
      console.log(`${changed} of ${entries.length} entries changed (last-login index updated)${purchaseNote}`);
    } catch (err) {
      fail(err);
    }
  });

demo
  .command('serve')
  .description('Serve the demo dataset as a mock Open Cloud v2 API')
  .option('-p, --port <n>', 'port', '4010')
  .option('-d, --data <dir>', 'dataset directory', DEMO_DIR)
  .option('--universe <id>', 'universe id', '1')
  .option('--api-key <key>', 'expected x-api-key', 'demo-key')
  .option('--rpm <n>', 'requests per minute before 429', '300')
  .option('--latency <ms>', 'artificial latency per request', '0')
  .action(async (o: { port: string; data: string; universe: string; apiKey: string; rpm: string; latency: string }) => {
    const mock = new MockOpenCloud({ dataDir: path.resolve(o.data), universeId: o.universe, apiKey: o.apiKey, rpm: Number(o.rpm), latencyMs: Number(o.latency) });
    const port = await mock.listen(Number(o.port));
    console.log(`mock Open Cloud listening on http://localhost:${port}  (universe ${o.universe}, ${o.rpm} req/min, x-api-key: ${o.apiKey})`);
    console.log(`serving datasets from ${path.resolve(o.data)}; ctrl-c to stop`);
    const shutdown = async () => {
      await mock.close();
      console.log(`\nrequests: ${mock.stats.requests}, throttled: ${mock.stats.throttled}, unauthorized: ${mock.stats.unauthorized}`);
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });

program.parseAsync(process.argv).catch(fail);
