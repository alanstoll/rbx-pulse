/**
 * Stage 4: milestone/flag events with bounded timing, and stat deltas.
 *
 * Milestones and flags are evaluated per profile version in order; the first
 * version where the condition holds produces one event per player and key.
 * Stat deltas are computed in SQL from the fact table for consecutive versions.
 */
import { createHash } from 'node:crypto';
import type { Pool } from '../db/client.js';
import type { PulseConfig, MilestoneConfig } from '../config/schema.js';
import { compile } from '../expr/engine.js';
import { canonicalJson } from '../sync/hash.js';
import type { Logger } from '../sync/engine.js';
import { toDate } from './extract.js';
import { buildDocument } from './runner.js';

export type Precision = 'exact' | 'revision' | 'interval';

export interface Timing {
  lo: Date | null;
  hi: Date;
  precision: Precision;
}

/**
 * When was a condition first satisfied?
 * - An `at` timestamp from the record: exact.
 * - Otherwise between the previous observation (or the entry's creation) and this
 *   version's last write; precision says whether the write time was available.
 */
export function milestoneTiming(args: {
  at: Date | null;
  version: { validFrom: Date; revisionCreatedAt: Date | null };
  previous: { validFrom: Date } | null;
  entryCreatedAt: Date | null;
}): Timing {
  if (args.at) return { lo: args.at, hi: args.at, precision: 'exact' };
  const hi = args.version.revisionCreatedAt ?? args.version.validFrom;
  let lo: Date | null = args.previous?.validFrom ?? args.entryCreatedAt ?? null;
  if (lo && lo > hi) lo = null;
  return { lo, hi, precision: args.version.revisionCreatedAt ? 'revision' : 'interval' };
}

export function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Derivation depends on facts (for deltas), milestones, flags and constants. */
export function deriveConfigHash(config: PulseConfig): string {
  return createHash('sha256')
    .update(canonicalJson({ facts: config.facts, milestones: config.milestones, flags: config.flags, constants: config.constants }))
    .digest('hex')
    .slice(0, 16);
}

export interface DeriveStats {
  playersProcessed: number;
  versionsProcessed: number;
  eventsCreated: number;
  deltasWritten: number;
  errors: Record<string, string>;
}

interface VersionRow {
  id: number;
  user_id: number;
  version_no: number;
  components: Record<string, number>;
  valid_from: Date;
  observed_at: Date | null;
  revision_created_at: Date | null;
  derived_hash: string | null;
  entry_created_at: Date | null;
}

interface SnapshotBody {
  id: number;
  datastore: string;
  body: unknown;
  entry_created_at: Date | null;
  revision_created_at: Date | null;
  observed_at: Date;
}

interface Definition {
  key: string;
  kind: 'milestone' | 'flag';
  ordinal: number;
  cfg: MilestoneConfig;
}

export async function deriveProfiles(pool: Pool, config: PulseConfig, log: Logger, opts: { userId?: number; rebuild?: boolean; batch?: number } = {}): Promise<DeriveStats> {
  const hash = deriveConfigHash(config);
  const stats: DeriveStats = { playersProcessed: 0, versionsProcessed: 0, eventsCreated: 0, deltasWritten: 0, errors: {} };
  const defs: Definition[] = [
    ...config.milestones.map((cfg, i) => ({ key: cfg.key, kind: 'milestone' as const, ordinal: i, cfg })),
    ...config.flags.map((cfg, i) => ({ key: cfg.key, kind: 'flag' as const, ordinal: i, cfg })),
  ];
  const BATCH = opts.batch ?? 200;
  const userFilter = opts.userId ? 'AND user_id = $2' : '';
  const params = (extra: unknown[] = []) => (opts.userId ? [hash, opts.userId, ...extra] : [hash, ...extra]);

  if (opts.rebuild) {
    await pool.query(`UPDATE profile_version SET derived_hash = NULL WHERE true ${userFilter.replace('$2', '$1')}`, opts.userId ? [opts.userId] : []);
  }

  for (;;) {
    const players = await pool.query<{ user_id: number }>(
      `SELECT DISTINCT user_id FROM profile_version WHERE derived_hash IS DISTINCT FROM $1 ${userFilter} ORDER BY user_id LIMIT ${BATCH}`,
      params(),
    );
    const uids = players.rows.map((r) => Number(r.user_id));
    if (!uids.length) break;

    const versions = await pool.query<VersionRow>(
      `SELECT pv.id, pv.user_id, pv.version_no, pv.components, pv.valid_from, pv.observed_at, pv.revision_created_at, pv.derived_hash, p.entry_created_at
         FROM profile_version pv JOIN player p ON p.user_id = pv.user_id
        WHERE pv.user_id = ANY($1::bigint[]) ORDER BY pv.user_id, pv.version_no`,
      [uids],
    );
    const pending = versions.rows.filter((v) => v.derived_hash !== hash);
    const pendingIds = pending.map((v) => Number(v.id));
    const snapIds = [...new Set(pending.flatMap((v) => Object.values(v.components)))];
    const snaps = snapIds.length
      ? await pool.query<SnapshotBody>(`SELECT id, datastore, body, entry_created_at, revision_created_at, observed_at FROM snapshot WHERE id = ANY($1::bigint[])`, [snapIds])
      : { rows: [] as SnapshotBody[] };
    const byId = new Map(snaps.rows.map((s) => [Number(s.id), s]));

    // Events already recorded under this config (older-config rows are discarded below).
    const existing = await pool.query<{ user_id: number; key: string }>(`SELECT user_id, key FROM milestone_event WHERE user_id = ANY($1::bigint[]) AND config_hash = $2`, [uids, hash]);
    const reached = new Map<number, Set<string>>();
    for (const r of existing.rows) {
      const uid = Number(r.user_id);
      if (!reached.has(uid)) reached.set(uid, new Set());
      reached.get(uid)!.add(r.key);
    }

    const ev = { uid: [] as number[], key: [] as string[], kind: [] as string[], ordinal: [] as number[], lo: [] as (Date | null)[], hi: [] as Date[], precision: [] as string[], pv: [] as number[] };
    const byUser = new Map<number, VersionRow[]>();
    for (const v of versions.rows) {
      const uid = Number(v.user_id);
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid)!.push(v);
    }

    for (const uid of uids) {
      const list = byUser.get(uid) ?? [];
      const done = reached.get(uid) ?? new Set<string>();
      for (let i = 0; i < list.length; i++) {
        const v = list[i]!;
        if (v.derived_hash === hash) continue;
        const todo = defs.filter((d) => !done.has(d.key));
        if (!todo.length) continue;
        const doc = buildDocument(config, v.components, byId);
        for (const d of todo) {
          let cond: unknown;
          try {
            cond = await compile(d.cfg.when).evaluate(doc.data, doc.bindings);
          } catch (err) {
            if (!stats.errors[d.key]) stats.errors[d.key] = (err as Error).message;
            continue;
          }
          if (!isTruthy(cond)) continue;
          let at: Date | null = null;
          if (d.cfg.at) {
            try {
              at = toDate(await compile(d.cfg.at).evaluate(doc.data, doc.bindings), d.cfg.unit);
            } catch (err) {
              if (!stats.errors[`${d.key}.at`]) stats.errors[`${d.key}.at`] = (err as Error).message;
            }
          }
          const t = milestoneTiming({
            at,
            version: { validFrom: v.valid_from, revisionCreatedAt: v.revision_created_at },
            // Lower bound: the last moment we know the previous state still held.
            previous: i > 0 ? { validFrom: list[i - 1]!.observed_at ?? list[i - 1]!.valid_from } : null,
            entryCreatedAt: v.entry_created_at,
          });
          ev.uid.push(uid);
          ev.key.push(d.key);
          ev.kind.push(d.kind);
          ev.ordinal.push(d.ordinal);
          ev.lo.push(t.lo);
          ev.hi.push(t.hi);
          ev.precision.push(t.precision);
          ev.pv.push(Number(v.id));
          done.add(d.key);
        }
      }
      stats.playersProcessed++;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM milestone_event WHERE user_id = ANY($1::bigint[]) AND config_hash <> $2`, [uids, hash]);
      if (ev.uid.length) {
        const r = await client.query(
          `INSERT INTO milestone_event (user_id, key, kind, ordinal, reached_lo, reached_hi, precision, profile_version_id, config_hash)
           SELECT u, k, kd, o, lo, hi, p, pv, $9 FROM unnest($1::bigint[], $2::text[], $3::text[], $4::int[], $5::timestamptz[], $6::timestamptz[], $7::text[], $8::bigint[]) AS t(u, k, kd, o, lo, hi, p, pv)
           ON CONFLICT (user_id, key) DO NOTHING`,
          [ev.uid, ev.key, ev.kind, ev.ordinal, ev.lo, ev.hi, ev.precision, ev.pv, hash],
        );
        stats.eventsCreated += r.rowCount ?? 0;
      }
      if (pendingIds.length) {
        await client.query(`DELETE FROM stat_delta WHERE to_version_id = ANY($1::bigint[])`, [pendingIds]);
        const d = await client.query(
          `INSERT INTO stat_delta (user_id, key, dim, from_version_id, to_version_id, from_at, to_at, from_value, to_value, delta, per_day, reset)
           SELECT b.user_id, b.key, b.dim, pva.id, pvb.id, pva.valid_from, COALESCE(pvb.revision_created_at, pvb.valid_from), a.num, b.num, b.num - a.num,
                  (b.num - a.num) / GREATEST(EXTRACT(EPOCH FROM (COALESCE(pvb.revision_created_at, pvb.valid_from) - pva.valid_from)) / 86400.0, 1.0 / 1440),
                  (b.kind = 'counter' AND b.num < a.num)
             FROM profile_version pvb
             JOIN profile_version pva ON pva.user_id = pvb.user_id AND pva.version_no = pvb.version_no - 1
             JOIN fact b ON b.profile_version_id = pvb.id AND b.kind IN ('counter', 'gauge') AND b.num IS NOT NULL
             JOIN fact a ON a.profile_version_id = pva.id AND a.key = b.key AND a.dim = b.dim AND a.num IS NOT NULL
            WHERE pvb.id = ANY($1::bigint[])`,
          [pendingIds],
        );
        stats.deltasWritten += d.rowCount ?? 0;
        await client.query(`UPDATE profile_version SET derived_hash = $2 WHERE id = ANY($1::bigint[])`, [pendingIds, hash]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    stats.versionsProcessed += pendingIds.length;
    log.info(`derived ${stats.playersProcessed} players, ${stats.versionsProcessed} versions, ${stats.eventsCreated} milestone/flag events, ${stats.deltasWritten} deltas`);
    if (opts.userId) break;
  }
  for (const [k, m] of Object.entries(stats.errors)) log.warn(`condition ${k}: ${m}`);
  return stats;
}
