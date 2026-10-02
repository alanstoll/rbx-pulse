import { createHash } from 'node:crypto';
import { discoveryOf, type PulseConfig, type DatastoreConfig } from '../config/schema.js';
import { KeyTemplate } from '../keys.js';
import { canonicalJson } from './hash.js';
import { OpenCloudClient, OpenCloudError } from './open-cloud.js';
import { RateLimiter } from './limiter.js';
import { msUntilOpen } from './window.js';
import { SyncStore, emptyStats, emptyDatastoreStats, type DatastoreCursor, type DatastoreStats, type SyncCursor, type SyncStats, type RunStatus } from './store.js';

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SyncOptions {
  config: PulseConfig;
  store: SyncStore;
  client: OpenCloudClient;
  limiter: RateLimiter;
  log: Logger;
  /** Start a new run even if a paused one exists. */
  fresh?: boolean;
  /** Stop after this many keys per datastore (testing); the run is left paused. */
  limit?: number;
  /** Restrict to these datastore names. */
  datastores?: string[];
  /** Aborting pauses the run after the current chunk; it resumes next time. */
  signal?: AbortSignal;
  /** Ignore the configured time-of-day window. */
  ignoreWindow?: boolean;
  /** List every key even when a last-login index is configured. */
  full?: boolean;
  progressIntervalMs?: number;
  /** Source of "now" for run and observation times (the demo seeder replays past weeks). */
  clock?: () => Date;
}

export interface SyncResult {
  runId: number;
  status: RunStatus;
  stats: SyncStats;
}

/** Identifies "the same sync job" across runs so a paused run can be resumed. */
export function configHash(config: PulseConfig): string {
  return createHash('sha256').update(canonicalJson({ universe: config.game.universeId, datastores: config.game.datastores })).digest('hex').slice(0, 16);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const { config, store, client, limiter, log } = opts;
  const clock = opts.clock ?? (() => new Date());
  const hash = configHash(config);
  const startedAt = Date.now();

  await store.pauseStaleRuns();
  let run = opts.fresh ? undefined : await store.findResumable(hash);
  const resumed = Boolean(run);
  if (!run) run = await store.createRun(hash, clock());
  await store.markRunning(run.id);

  const cursor: SyncCursor = run.cursor ?? { datastores: {} };
  const stats: SyncStats = { ...emptyStats(), ...(run.stats ?? {}) };
  const baseRequests = client.stats.requests;
  const baseThrottled = client.stats.throttled;
  const elapsedBefore = stats.elapsedMs;
  const syncStats = (): SyncStats => ({
    ...stats,
    requests: stats.requests + (client.stats.requests - baseRequests),
    throttled: stats.throttled + (client.stats.throttled - baseThrottled),
    elapsedMs: elapsedBefore + (Date.now() - startedAt),
  });

  const index = config.game.sync.index;
  const indexTemplate = index ? new KeyTemplate(index.keyTemplate) : undefined;
  stats.datastores ??= {};

  // The index only vouches for logins since the game started writing it, so index mode
  // needs its oldest entry to predate the cutoff. Open Cloud answers an empty 200 for an
  // ordered datastore that does not exist, so "not shipped yet" reads as no oldest entry.
  // The oldest value drifts later as early players return; that errs toward full listings.
  let indexStart: Promise<number | undefined> | undefined;
  const oldestIndexMs = async (): Promise<number | undefined> => {
    try {
      const page = await client.listOrderedEntries(index!.orderedDatastore, index!.scope, undefined, false, 1);
      const v = page.entries[0]?.value;
      if (v === undefined || !Number.isFinite(v)) return undefined;
      return index!.valueUnit === 'millis' ? v : v * 1000;
    } catch (err) {
      if (err instanceof OpenCloudError && err.status === 404) return undefined;
      throw err;
    }
  };

  log.info(`${resumed ? 'resuming' : 'starting'} sync run #${run.id} (config ${hash}) at up to ${limiter.rate} req/min`);

  const targets = config.game.datastores.filter((d) => !opts.datastores || opts.datastores.includes(d.name));
  let status: RunStatus = 'completed';
  let lastProgress = Date.now();
  const progressEvery = opts.progressIntervalMs ?? 10_000;

  const report = (ds: DatastoreConfig, c: DatastoreCursor, d: DatastoreStats, force = false): void => {
    const since = Date.now() - lastProgress;
    if (since < (force ? 1000 : progressEvery)) return;
    lastProgress = Date.now();
    const s = syncStats();
    const mins = Math.max(1 / 60, s.elapsedMs / 60_000);
    log.info(
      `${ds.name}: page ${c.pages}, ${d.checked} checked (${d.changed} changed, ${d.missing} missing, ${d.absent} absent, ${d.errors} errors), ` +
        `${Math.round(s.requests / mins)} req/min avg, throttled ${s.throttled}`,
    );
  };

  /** Increment a counter on both the run total and the datastore's own line. */
  const bump = (d: DatastoreStats, k: keyof DatastoreStats & ('listed' | 'checked' | 'changed' | 'unchanged' | 'missing' | 'absent' | 'errors' | 'skippedKeys'), n = 1): void => {
    d[k] += n;
    stats[k] += n;
  };

  try {
    for (const ds of targets) {
      let c = cursor.datastores[ds.name];
      const dstats = (stats.datastores[ds.name] ??= emptyDatastoreStats());
      if (!c) {
        // New cursor: decide how this datastore's keys are found. Index mode needs a
        // previous completed listing of this very datastore to take its cutoff from.
        c = { done: false, index: 0, pages: 0, mode: 'full' };
        if (index && !opts.full && discoveryOf(ds, config.game) === 'index') {
          const last = await store.lastCompletedFor(ds.name);
          if (last) {
            const cutoff = last.getTime() - index.marginMinutes * 60_000;
            const start = await (indexStart ??= oldestIndexMs());
            if (start === undefined) {
              log.warn(`${index.orderedDatastore} has no entries (not written yet?); ${ds.name} falls back to a full listing`);
            } else if (start > cutoff) {
              log.info(`${index.orderedDatastore} only reaches back to ${new Date(start).toISOString()}, after the cutoff; ${ds.name} falls back to a full listing`);
            } else {
              c.mode = 'index';
              c.since = new Date(cutoff).toISOString();
            }
          }
        }
        cursor.datastores[ds.name] = c;
      }
      dstats.mode = c.mode;
      dstats.since = c.since;
      if (c.mode === 'index') {
        stats.mode = 'index';
        stats.since ??= c.since;
      } else stats.mode ??= 'full';
      if (c.done) continue;
      const sinceMs = c.mode === 'index' && c.since ? new Date(c.since).getTime() : undefined;
      log.info(`${ds.name}: ${sinceMs !== undefined ? `incremental via ${index!.orderedDatastore} since ${c.since}` : 'full listing'}`);
      const template = new KeyTemplate(ds.keyTemplate);
      const primary = ds === config.game.datastores[0];
      // Keys found through the index were not listed from this store, so a 404 on a
      // supplemental store means the player simply has no entry there.
      const listed = sinceMs === undefined;
      let keysThisRun = 0;

      while (!c.done) {
        // Window and abort checks happen between chunks, so state is always consistent.
        if (opts.signal?.aborted) throw new Paused('aborted');
        if (opts.limit !== undefined && keysThisRun >= opts.limit) {
          stats.limited = true;
          throw new Paused(`key limit ${opts.limit} reached`);
        }
        if (!opts.ignoreWindow) {
          const wait = msUntilOpen(config.game.sync.window);
          if (wait > 0) {
            log.info(`outside sync window; sleeping ${Math.round(wait / 60_000)} min`);
            await store.saveProgress(run.id, cursor, syncStats());
            await sleep(Math.min(wait, 60_000));
            continue;
          }
        }

        // Fetch a page if we have no page in progress.
        if (!c.keys) {
          const page = sinceMs !== undefined ? await listIndexPage(c.pageToken) : await client.listEntries(ds.name, ds.scope, c.pageToken);
          c.keys = page.ids;
          c.index = 0;
          c.pages++;
          bump(dstats, 'listed', page.ids.length);
          // Remember where the next page starts, but only advance once this page is finished.
          c.nextPageToken = page.nextPageToken;
          await store.saveProgress(run.id, cursor, syncStats());
        }

        // Process the remaining keys of the page with a pool of `concurrency` workers.
        // Dispatch is sequential and every dispatched key is awaited before the pool
        // returns, so the cursor index is always a contiguous prefix of finished keys.
        const keys = c.keys;
        let dispatch = c.index;
        let finished = c.index;
        let stopReason: string | undefined;
        let lastSave = finished;
        const worker = async (): Promise<void> => {
          while (dispatch < keys.length) {
            if (opts.signal?.aborted) {
              stopReason ??= 'aborted';
              return;
            }
            if (opts.limit !== undefined && keysThisRun >= opts.limit) {
              stats.limited = true;
              stopReason ??= `key limit ${opts.limit} reached`;
              return;
            }
            const key = keys[dispatch++]!;
            keysThisRun++;
            await processKey(key);
            finished++;
            report(ds, c, dstats);
          }
        };
        const pool: Promise<void>[] = [];
        for (let i = 0; i < config.game.sync.concurrency; i++) {
          pool.push(
            (async () => {
              await worker();
            })(),
          );
        }
        // Save progress periodically while the pool runs.
        const ticker = setInterval(() => {
          if (finished - lastSave >= 25) {
            lastSave = finished;
            c.index = finished;
            void store.saveProgress(run!.id, cursor, syncStats()).catch((e: Error) => log.warn(`progress save failed: ${e.message}`));
          }
        }, 2000);
        try {
          await Promise.all(pool);
        } finally {
          clearInterval(ticker);
        }
        c.index = finished;
        if (stopReason) {
          await store.saveProgress(run.id, cursor, syncStats());
          throw new Paused(stopReason);
        }

        // Page finished: advance.
        const next = c.nextPageToken;
        delete c.nextPageToken;
        c.keys = undefined;
        c.index = 0;
        if (next) c.pageToken = next;
        else c.done = true;
        await store.saveProgress(run.id, cursor, syncStats());
      }
      report(ds, c, dstats, true);

      /** One page of target keys from the ordered index, stopping once values fall before `since`. */
      async function listIndexPage(token: string | undefined): Promise<{ ids: string[]; nextPageToken?: string }> {
        const page = await client.listOrderedEntries(index!.orderedDatastore, index!.scope, token, true);
        const ids: string[] = [];
        let stop = false;
        for (const e of page.entries) {
          const ms = index!.valueUnit === 'millis' ? e.value : e.value * 1000;
          if (!Number.isFinite(ms) || ms < sinceMs!) {
            stop = true;
            break;
          }
          const uid = indexTemplate!.parse(e.id);
          if (uid === undefined) {
            bump(dstats, 'skippedKeys');
            continue;
          }
          ids.push(template.build(uid));
        }
        return { ids, ...(!stop && page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
      }

      async function processKey(key: string): Promise<void> {
        const userId = template.parse(key);
        if (userId === undefined || (userId < 0 && !config.game.sync.includeTestPlayers)) {
          bump(dstats, 'skippedKeys');
          return;
        }
        const observedAt = clock();
        try {
          const entry = await client.getEntry(ds.name, ds.scope, key);
          bump(dstats, 'checked');
          if (!entry) {
            const status = !primary && !listed ? 'absent' : 'missing';
            bump(dstats, status);
            await store.recordNonEntry({ runId: run!.id, userId, datastore: ds.name, observedAt, status });
            return;
          }
          const r = await store.recordEntry({ runId: run!.id, userId, datastore: ds.name, observedAt, entry, primary });
          bump(dstats, r.changed ? 'changed' : 'unchanged');
        } catch (err) {
          if (err instanceof OpenCloudError && err.fatal) throw err;
          bump(dstats, 'errors');
          log.warn(`${ds.name}/${key}: ${(err as Error).message}`);
          await store.recordNonEntry({ runId: run!.id, userId, datastore: ds.name, observedAt, status: 'error' });
        }
      }
    }
  } catch (err) {
    if (err instanceof Paused) {
      status = 'paused';
      log.info(`run #${run.id} paused: ${err.message}`);
    } else {
      status = 'failed';
      log.warn(`run #${run.id} failed: ${(err as Error).message}`);
      await store.finishRun(run.id, status, cursor, syncStats(), clock());
      throw err;
    }
  }

  const finalStats = syncStats();
  await store.finishRun(run.id, status, cursor, finalStats, clock());
  log.info(
    `run #${run.id} ${status}: ${finalStats.checked} checked, ${finalStats.changed} changed, ${finalStats.unchanged} unchanged, ` +
      `${finalStats.missing} missing, ${finalStats.absent} absent, ${finalStats.errors} errors, ${finalStats.skippedKeys} skipped keys, ${finalStats.requests} requests, ${finalStats.throttled} throttled, ` +
      `${(finalStats.elapsedMs / 1000).toFixed(1)}s`,
  );
  if (targets.length > 1) {
    for (const ds of targets) {
      const d = finalStats.datastores?.[ds.name];
      if (d) log.info(`  ${ds.name} (${d.mode ?? 'full'}): ${d.listed} listed, ${d.checked} checked, ${d.changed} changed, ${d.missing} missing, ${d.absent} absent, ${d.errors} errors`);
    }
  }
  return { runId: run.id, status, stats: finalStats };
}

class Paused extends Error {}
