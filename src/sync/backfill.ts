/**
 * Optional first-run backfill from Open Cloud revision history. Roblox keeps prior
 * revisions of a DataStore entry for about 30 days after they are overwritten, so a
 * player who was active recently has a short trail of past states we can turn into
 * earlier snapshots. Each revision costs one read request.
 */
import type { Pool } from '../db/client.js';
import type { PulseConfig } from '../config/schema.js';
import { KeyTemplate } from '../keys.js';
import { contentHash } from './hash.js';
import type { OpenCloudClient } from './open-cloud.js';
import { OpenCloudError } from './open-cloud.js';
import type { Logger } from './engine.js';

export interface BackfillOptions {
  /** Only revisions newer than this many days ago. */
  days: number;
  /** Per player and datastore. */
  maxRevisions: number;
  userId?: number;
  signal?: AbortSignal;
}

export interface BackfillStats {
  playersConsidered: number;
  revisionsListed: number;
  revisionsFetched: number;
  snapshotsInserted: number;
  errors: number;
}

export async function backfillRevisions(pool: Pool, config: PulseConfig, client: OpenCloudClient, log: Logger, opts: BackfillOptions): Promise<BackfillStats> {
  const stats: BackfillStats = { playersConsidered: 0, revisionsListed: 0, revisionsFetched: 0, snapshotsInserted: 0, errors: 0 };
  const cutoff = new Date(Date.now() - opts.days * 86_400_000);

  for (const ds of config.game.datastores) {
    if (!ds.sync.backfill) {
      log.info(`backfill: skipping ${ds.name} (sync.backfill: false)`);
      continue;
    }
    const template = new KeyTemplate(ds.keyTemplate);
    // Players whose latest known revision is recent enough to have retained history.
    const players = await pool.query<{ user_id: number; revision_id: string | null; known: string[] }>(
      `SELECT s.user_id,
              (SELECT revision_id FROM snapshot x WHERE x.user_id = s.user_id AND x.datastore = s.datastore ORDER BY observed_at DESC, id DESC LIMIT 1) AS revision_id,
              array_agg(s.content_hash) AS known
         FROM snapshot s
        WHERE s.datastore = $1 ${opts.userId ? 'AND s.user_id = $3' : ''}
        GROUP BY s.user_id, s.datastore
       HAVING max(s.revision_created_at) >= $2
        ORDER BY s.user_id`,
      opts.userId ? [ds.name, cutoff, opts.userId] : [ds.name, cutoff],
    );
    for (const p of players.rows) {
      if (opts.signal?.aborted) break;
      stats.playersConsidered++;
      const userId = Number(p.user_id);
      const key = template.build(userId);
      const known = new Set(p.known);
      const knownRevisions = new Set(
        (await pool.query<{ revision_id: string }>(`SELECT revision_id FROM snapshot WHERE user_id = $1 AND datastore = $2 AND revision_id IS NOT NULL`, [userId, ds.name])).rows.map((r) => r.revision_id),
      );
      let token: string | undefined;
      let fetched = 0;
      let stop = false;
      try {
        do {
          const page = await client.listRevisions(ds.name, ds.scope, key, token);
          token = page.nextPageToken;
          for (const rev of page.revisions) {
            stats.revisionsListed++;
            const at = new Date(rev.revisionCreateTime);
            if (at < cutoff) {
              stop = true;
              break;
            }
            if (fetched >= opts.maxRevisions) {
              stop = true;
              break;
            }
            if (knownRevisions.has(rev.revisionId)) continue;
            const entry = await client.getEntryRevision(ds.name, ds.scope, key, rev.revisionId);
            fetched++;
            stats.revisionsFetched++;
            if (!entry) continue;
            const hash = contentHash(entry.value);
            if (known.has(hash)) continue;
            known.add(hash);
            await pool.query(
              `INSERT INTO snapshot (user_id, datastore, content_hash, body, revision_id, revision_created_at, entry_created_at, observed_at, sync_run_id, source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $6, NULL, 'backfill')`,
              [userId, ds.name, hash, JSON.stringify(entry.value), rev.revisionId, at, entry.createTime ? new Date(entry.createTime) : null],
            );
            stats.snapshotsInserted++;
          }
        } while (token && !stop && !opts.signal?.aborted);
      } catch (err) {
        if (err instanceof OpenCloudError && err.fatal) throw err;
        stats.errors++;
        log.warn(`backfill ${ds.name}/${key}: ${(err as Error).message}`);
      }
      if (stats.playersConsidered % 50 === 0) {
        log.info(`backfill: ${stats.playersConsidered} players, ${stats.revisionsFetched} revisions fetched, ${stats.snapshotsInserted} snapshots added`);
      }
    }
  }
  return stats;
}
