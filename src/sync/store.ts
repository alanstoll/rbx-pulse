import type { Pool } from '../db/client.js';
import { contentHash } from './hash.js';
import type { Entry } from './open-cloud.js';

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed';

export interface DatastoreCursor {
  done: boolean;
  /** Token used to fetch the page currently in progress (undefined = first page). */
  pageToken?: string;
  /** Ids of the page in progress, and how many of them are finished. */
  keys?: string[];
  index: number;
  /** Token for the page after the one in progress; applied once that page completes. */
  nextPageToken?: string;
  pages: number;
  /** How this datastore's keys were found in this run (decided when the cursor is created). */
  mode?: 'full' | 'index';
  /** Index mode: only players active since this instant (ISO) were fetched. */
  since?: string;
}

export interface SyncCursor {
  datastores: Record<string, DatastoreCursor>;
}

/** Counters kept per datastore and, summed, for the run. */
export interface DatastoreStats {
  mode?: 'full' | 'index';
  since?: string;
  listed: number;
  checked: number;
  changed: number;
  unchanged: number;
  /** A listed key that no longer exists. */
  missing: number;
  /** A supplemental store that has no entry for a player found through the index (expected; not a problem). */
  absent: number;
  errors: number;
  skippedKeys: number;
}

export interface SyncStats extends DatastoreStats {
  /** index = at least one datastore was fetched incrementally through the ordered index. */
  requests: number;
  throttled: number;
  elapsedMs: number;
  limited?: boolean;
  datastores?: Record<string, DatastoreStats>;
}

export const emptyDatastoreStats = (): DatastoreStats => ({ listed: 0, checked: 0, changed: 0, unchanged: 0, missing: 0, absent: 0, errors: 0, skippedKeys: 0 });
export const emptyStats = (): SyncStats => ({ ...emptyDatastoreStats(), requests: 0, throttled: 0, elapsedMs: 0 });

export interface RunRow {
  id: number;
  status: RunStatus;
  config_hash: string | null;
  cursor: SyncCursor;
  stats: SyncStats;
  started_at: Date;
  finished_at: Date | null;
}

export interface RecordResult {
  changed: boolean;
  snapshotId: number;
}

/** All database access for the sync stage. */
export class SyncStore {
  constructor(private readonly pool: Pool) {}

  /** Any run left 'running' by a crashed process becomes resumable. */
  async pauseStaleRuns(): Promise<number> {
    const r = await this.pool.query(`UPDATE sync_run SET status = 'paused' WHERE status = 'running'`);
    return r.rowCount ?? 0;
  }

  async findResumable(configHash: string): Promise<RunRow | undefined> {
    const r = await this.pool.query<RunRow>(
      `SELECT id, status, config_hash, cursor, stats, started_at, finished_at FROM sync_run
       WHERE status = 'paused' AND config_hash = $1 ORDER BY started_at DESC LIMIT 1`,
      [configHash],
    );
    return r.rows[0];
  }

  /**
   * Start time of the most recent completed run that finished listing this datastore,
   * for incremental syncs. Tracked per datastore so that adding a store, or a run
   * restricted with --datastore, never moves another store's cutoff.
   */
  async lastCompletedFor(datastore: string): Promise<Date | undefined> {
    const r = await this.pool.query<{ started_at: Date }>(
      `SELECT started_at FROM sync_run
        WHERE status = 'completed' AND (stats->>'limited') IS DISTINCT FROM 'true'
          AND (cursor->'datastores'->$1->>'done') = 'true'
        ORDER BY started_at DESC LIMIT 1`,
      [datastore],
    );
    return r.rows[0]?.started_at;
  }

  async createRun(configHash: string, startedAt: Date = new Date()): Promise<RunRow> {
    const r = await this.pool.query<RunRow>(
      `INSERT INTO sync_run (config_hash, cursor, stats, started_at) VALUES ($1, $2, $3, $4)
       RETURNING id, status, config_hash, cursor, stats, started_at, finished_at`,
      [configHash, JSON.stringify({ datastores: {} }), JSON.stringify(emptyStats()), startedAt],
    );
    return r.rows[0]!;
  }

  async markRunning(runId: number): Promise<void> {
    await this.pool.query(`UPDATE sync_run SET status = 'running', finished_at = NULL WHERE id = $1`, [runId]);
  }

  async saveProgress(runId: number, cursor: SyncCursor, stats: SyncStats): Promise<void> {
    await this.pool.query(`UPDATE sync_run SET cursor = $2, stats = $3 WHERE id = $1`, [runId, JSON.stringify(cursor), JSON.stringify(stats)]);
  }

  async finishRun(runId: number, status: RunStatus, cursor: SyncCursor, stats: SyncStats, finishedAt: Date = new Date()): Promise<void> {
    await this.pool.query(`UPDATE sync_run SET status = $2, cursor = $3, stats = $4, finished_at = $5 WHERE id = $1`, [
      runId,
      status,
      JSON.stringify(cursor),
      JSON.stringify(stats),
      finishedAt,
    ]);
  }

  async listRuns(limit = 20): Promise<RunRow[]> {
    const r = await this.pool.query<RunRow>(
      `SELECT id, status, config_hash, cursor, stats, started_at, finished_at FROM sync_run ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  }

  /**
   * Record a fetched entry: upsert the player, store a snapshot if the content
   * changed since the latest one, and always write an observation.
   */
  async recordEntry(args: { runId: number; userId: number; datastore: string; observedAt: Date; entry: Entry; primary: boolean }): Promise<RecordResult> {
    const { runId, userId, datastore, observedAt, entry, primary } = args;
    const hash = contentHash(entry.value);
    const revisionAt = entry.revisionCreateTime ? new Date(entry.revisionCreateTime) : null;
    const createdAt = entry.createTime ? new Date(entry.createTime) : null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO player (user_id, first_seen_at, last_seen_at, entry_created_at)
         VALUES ($1, $2, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET
           last_seen_at = EXCLUDED.last_seen_at,
           entry_created_at = COALESCE(player.entry_created_at, EXCLUDED.entry_created_at),
           purged_at = NULL`,
        [userId, observedAt, primary ? createdAt : null],
      );
      const latest = await client.query<{ id: number; content_hash: string }>(
        `SELECT id, content_hash FROM snapshot WHERE user_id = $1 AND datastore = $2 ORDER BY observed_at DESC, id DESC LIMIT 1`,
        [userId, datastore],
      );
      let snapshotId: number;
      let changed: boolean;
      if (latest.rows[0] && latest.rows[0].content_hash === hash) {
        snapshotId = latest.rows[0].id;
        changed = false;
      } else {
        const ins = await client.query<{ id: number }>(
          `INSERT INTO snapshot (user_id, datastore, content_hash, body, revision_id, revision_created_at, entry_created_at, observed_at, sync_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [userId, datastore, hash, JSON.stringify(entry.value), entry.revisionId ?? null, revisionAt, createdAt, observedAt, runId],
        );
        snapshotId = ins.rows[0]!.id;
        changed = true;
      }
      await client.query(
        `INSERT INTO observation (sync_run_id, user_id, datastore, observed_at, changed, snapshot_id, revision_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ok')`,
        [runId, userId, datastore, observedAt, changed, snapshotId, entry.revisionId ?? null],
      );
      await client.query('COMMIT');
      return { changed, snapshotId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * A listed key that no longer exists (`missing`), a key that failed permanently
   * (`error`), or a supplemental store with no entry for a player reached through the
   * index (`absent`). Absent observations are only recorded for players we already
   * know, and never create a player row.
   */
  async recordNonEntry(args: { runId: number; userId: number; datastore: string; observedAt: Date; status: 'missing' | 'error' | 'absent' }): Promise<void> {
    const { runId, userId, datastore, observedAt, status } = args;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (status !== 'absent') {
        await client.query(
          `INSERT INTO player (user_id, first_seen_at, last_seen_at) VALUES ($1, $2, $2)
           ON CONFLICT (user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
          [userId, observedAt],
        );
      }
      await client.query(
        `INSERT INTO observation (sync_run_id, user_id, datastore, observed_at, changed, status)
         SELECT $1, $2, $3, $4, false, $5 WHERE EXISTS (SELECT 1 FROM player WHERE user_id = $2)`,
        [runId, userId, datastore, observedAt, status],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Remove every trace of a player. Snapshots and observations cascade. */
  async purge(userId: number): Promise<{ snapshots: number; observations: number; player: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const s = await client.query(`DELETE FROM snapshot WHERE user_id = $1`, [userId]);
      const o = await client.query(`DELETE FROM observation WHERE user_id = $1`, [userId]);
      const p = await client.query(`DELETE FROM player WHERE user_id = $1`, [userId]);
      await client.query('COMMIT');
      return { snapshots: s.rowCount ?? 0, observations: o.rowCount ?? 0, player: p.rowCount ?? 0 };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
