/**
 * Player enrichment from the Open Cloud users API: username, display name, account
 * creation time, locale, premium. Public profile data, one request per player.
 */
import type { Pool } from '../db/client.js';
import type { OpenCloudClient } from './open-cloud.js';
import { OpenCloudError } from './open-cloud.js';
import type { Logger } from './engine.js';

export interface EnrichOptions {
  /** Re-fetch players enriched longer ago than this. 0 = only never-enriched players. */
  refreshDays: number;
  max?: number;
  userId?: number;
  signal?: AbortSignal;
}

export interface EnrichStats {
  attempted: number;
  updated: number;
  missing: number;
  errors: number;
}

export async function enrichPlayers(pool: Pool, client: OpenCloudClient, log: Logger, opts: EnrichOptions): Promise<EnrichStats> {
  const stats: EnrichStats = { attempted: 0, updated: 0, missing: 0, errors: 0 };
  const params: unknown[] = [];
  let where = 'purged_at IS NULL AND user_id > 0';
  if (opts.userId) {
    params.push(opts.userId);
    where += ` AND user_id = $${params.length}`;
  } else if (opts.refreshDays > 0) {
    params.push(opts.refreshDays);
    where += ` AND (enriched_at IS NULL OR enriched_at < now() - ($${params.length} || ' days')::interval)`;
  } else {
    where += ' AND enriched_at IS NULL';
  }
  const limit = opts.max ? ` LIMIT ${Math.max(1, Math.floor(opts.max))}` : '';
  const rows = await pool.query<{ user_id: number }>(`SELECT user_id FROM player WHERE ${where} ORDER BY enriched_at NULLS FIRST, user_id${limit}`, params);

  for (const r of rows.rows) {
    if (opts.signal?.aborted) break;
    const userId = Number(r.user_id);
    stats.attempted++;
    try {
      const u = await client.getUser(userId);
      if (!u) {
        stats.missing++;
        await pool.query(`UPDATE player SET enriched_at = now() WHERE user_id = $1`, [userId]);
        continue;
      }
      await pool.query(
        `UPDATE player SET username = $2, display_name = $3, account_created_at = $4, locale = $5, premium = $6, enriched_at = now() WHERE user_id = $1`,
        [userId, u.name ?? null, u.displayName ?? null, u.createTime ? new Date(u.createTime) : null, u.locale ?? null, u.premium ?? null],
      );
      stats.updated++;
    } catch (err) {
      if (err instanceof OpenCloudError && err.fatal) throw err;
      stats.errors++;
      log.warn(`enrich ${userId}: ${(err as Error).message}`);
    }
    if (stats.attempted % 100 === 0) log.info(`enrich: ${stats.attempted} players, ${stats.updated} updated`);
  }
  return stats;
}
