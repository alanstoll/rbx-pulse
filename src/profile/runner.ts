/**
 * Database orchestration for stages 2 and 3: assemble profile versions from
 * snapshots, extract facts from versions that need it, regenerate wide views.
 */
import type { Pool } from '../db/client.js';
import type { PulseConfig } from '../config/schema.js';
import type { Logger } from '../sync/engine.js';
import { composeVersions, isPrefix, type SnapshotRef } from './assemble.js';
import { extractFacts, extractSegments, extractConfigHash, type FactRow } from './extract.js';
import { wideViewSql } from './views.js';
import { composeDocument, type ProfileDocument, type StorePart } from './document.js';

export interface AssembleStats {
  playersExamined: number;
  playersRebuilt: number;
  versionsCreated: number;
}

export interface ExtractStats {
  versionsExtracted: number;
  factsWritten: number;
  segmentsWritten: number;
  eventsWritten: number;
  errors: Record<string, string>;
}

interface VersionRow {
  id: number;
  user_id: number;
  version_no: number;
  components: Record<string, number>;
  valid_from: Date;
  valid_to: Date | null;
}

interface SnapshotBody {
  id: number;
  datastore: string;
  body: unknown;
  entry_created_at: Date | null;
  revision_created_at: Date | null;
  observed_at: Date;
}

/** Build profile versions for every player that has snapshots newer than their latest version. */
export async function assembleProfiles(pool: Pool, log: Logger, opts: { rebuild?: boolean; userId?: number; primary?: string } = {}): Promise<AssembleStats> {
  const stats: AssembleStats = { playersExamined: 0, playersRebuilt: 0, versionsCreated: 0 };
  if (opts.rebuild) {
    await pool.query(opts.userId ? 'DELETE FROM profile_version WHERE user_id = $1' : 'DELETE FROM profile_version', opts.userId ? [opts.userId] : []);
  }
  const pending = await pool.query<{ user_id: number }>(
    `SELECT s.user_id
       FROM (SELECT user_id, max(id) AS m FROM snapshot GROUP BY user_id) s
       LEFT JOIN (SELECT user_id, max(max_snapshot_id) AS pm FROM profile_version GROUP BY user_id) p USING (user_id)
      WHERE (p.pm IS NULL OR p.pm < s.m) ${opts.userId ? 'AND s.user_id = $1' : ''}
      ORDER BY s.user_id`,
    opts.userId ? [opts.userId] : [],
  );
  const users = pending.rows.map((r) => Number(r.user_id));
  stats.playersExamined = users.length;
  const BATCH = 500;
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    const snaps = await pool.query<{ id: number; user_id: number; datastore: string; observed_at: Date; revision_created_at: Date | null }>(
      `SELECT id, user_id, datastore, observed_at, revision_created_at FROM snapshot WHERE user_id = ANY($1::bigint[]) ORDER BY user_id, observed_at, id`,
      [batch],
    );
    const existing = await pool.query<VersionRow>(
      `SELECT id, user_id, version_no, components, valid_from, valid_to FROM profile_version WHERE user_id = ANY($1::bigint[]) ORDER BY user_id, version_no`,
      [batch],
    );
    const byUser = new Map<number, SnapshotRef[]>();
    for (const s of snaps.rows) {
      const uid = Number(s.user_id);
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid)!.push({ id: Number(s.id), datastore: s.datastore, observedAt: s.observed_at, revisionCreatedAt: s.revision_created_at });
    }
    const existingByUser = new Map<number, VersionRow[]>();
    for (const v of existing.rows) {
      const uid = Number(v.user_id);
      if (!existingByUser.has(uid)) existingByUser.set(uid, []);
      existingByUser.get(uid)!.push(v);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const uid of batch) {
        const computed = composeVersions(byUser.get(uid) ?? [], opts.primary);
        let have = existingByUser.get(uid) ?? [];
        if (!isPrefix(have.map((v) => ({ versionNo: v.version_no, components: v.components })), computed)) {
          await client.query('DELETE FROM profile_version WHERE user_id = $1', [uid]);
          have = [];
          stats.playersRebuilt++;
        }
        for (let n = have.length; n < computed.length; n++) {
          const v = computed[n]!;
          if (n > 0) {
            // Close the previous version (whether pre-existing or just inserted) and its facts.
            await client.query(`UPDATE profile_version SET valid_to = $2 WHERE user_id = $1 AND version_no = $3`, [uid, v.validFrom, n]);
            await client.query(`UPDATE fact f SET valid_to = $2 FROM profile_version pv WHERE f.profile_version_id = pv.id AND pv.user_id = $1 AND pv.version_no = $3`, [uid, v.validFrom, n]);
            await client.query(`UPDATE segment_membership s SET valid_to = $2 FROM profile_version pv WHERE s.profile_version_id = pv.id AND pv.user_id = $1 AND pv.version_no = $3`, [uid, v.validFrom, n]);
          }
          await client.query(
            `INSERT INTO profile_version (user_id, version_no, components, max_snapshot_id, valid_from, valid_to, revision_created_at, observed_at)
             VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
            [uid, v.versionNo, JSON.stringify(v.components), v.maxSnapshotId, v.validFrom, v.revisionCreatedAt, v.observedAt],
          );
          stats.versionsCreated++;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    log.info(`assembled ${Math.min(i + BATCH, users.length)}/${users.length} players, ${stats.versionsCreated} new versions`);
  }
  return stats;
}

/** Build the composite document for one version from its component snapshots. */
export function buildDocument(config: PulseConfig, components: Record<string, number>, snapshots: Map<number, SnapshotBody>): ProfileDocument {
  const parts = new Map<string, StorePart>();
  for (const ds of config.game.datastores) {
    const sid = components[ds.name];
    if (sid === undefined) continue;
    const snap = snapshots.get(sid);
    if (!snap) continue;
    parts.set(ds.name, {
      body: snap.body,
      entry: { createTime: snap.entry_created_at?.toISOString() ?? null, revisionCreateTime: snap.revision_created_at?.toISOString() ?? null, observedAt: snap.observed_at.toISOString() },
    });
  }
  return composeDocument(config, parts);
}

/** Extract facts for every version not yet extracted with the current facts config. */
export async function extractProfiles(pool: Pool, config: PulseConfig, log: Logger, opts: { userId?: number; batch?: number } = {}): Promise<ExtractStats> {
  const hash = extractConfigHash(config);
  const stats: ExtractStats = { versionsExtracted: 0, factsWritten: 0, segmentsWritten: 0, eventsWritten: 0, errors: {} };
  const BATCH = opts.batch ?? 200;
  for (;;) {
    const versions = await pool.query<VersionRow>(
      `SELECT id, user_id, version_no, components, valid_from, valid_to FROM profile_version
        WHERE (extracted_at IS NULL OR config_hash IS DISTINCT FROM $1) ${opts.userId ? 'AND user_id = $2' : ''}
        ORDER BY id LIMIT ${BATCH}`,
      opts.userId ? [hash, opts.userId] : [hash],
    );
    if (!versions.rows.length) break;
    const snapIds = [...new Set(versions.rows.flatMap((v) => Object.values(v.components)))];
    const snaps = await pool.query<SnapshotBody>(`SELECT id, datastore, body, entry_created_at, revision_created_at, observed_at FROM snapshot WHERE id = ANY($1::bigint[])`, [snapIds]);
    const byId = new Map(snaps.rows.map((s) => [Number(s.id), s]));

    const factCols = { pv: [] as number[], uid: [] as number[], key: [] as string[], dim: [] as string[], kind: [] as string[], num: [] as (number | null)[], bool: [] as (boolean | null)[], text: [] as (string | null)[], ts: [] as (Date | null)[], from: [] as Date[], to: [] as (Date | null)[] };
    const evCols = { uid: [] as number[], type: [] as string[], data: [] as string[], ts: [] as Date[], pv: [] as number[], attrs: [] as (string | null)[] };
    const segCols = { pv: [] as number[], uid: [] as number[], key: [] as string[], member: [] as boolean[], label: [] as (string | null)[], from: [] as Date[], to: [] as (Date | null)[] };
    for (const v of versions.rows) {
      const doc = buildDocument(config, v.components, byId);
      for (const [k, m] of Object.entries(doc.warnings)) if (!stats.errors[k]) stats.errors[k] = m;
      const r = await extractFacts(config.facts, doc);
      for (const [k, m] of Object.entries(r.errors)) if (!stats.errors[k]) stats.errors[k] = m;
      const sg = await extractSegments(config.segments, doc);
      for (const [k, m] of Object.entries(sg.errors)) if (!stats.errors[`segment ${k}`]) stats.errors[`segment ${k}`] = m;
      for (const s of sg.segments) {
        segCols.pv.push(Number(v.id));
        segCols.uid.push(Number(v.user_id));
        segCols.key.push(s.key);
        segCols.member.push(s.member);
        segCols.label.push(s.label);
        segCols.from.push(v.valid_from);
        segCols.to.push(v.valid_to);
      }
      const push = (f: FactRow) => {
        factCols.pv.push(Number(v.id));
        factCols.uid.push(Number(v.user_id));
        factCols.key.push(f.key);
        factCols.dim.push(f.dim);
        factCols.kind.push(f.kind);
        factCols.num.push(f.num);
        factCols.bool.push(f.bool);
        factCols.text.push(f.text);
        factCols.ts.push(f.ts);
        factCols.from.push(v.valid_from);
        factCols.to.push(v.valid_to);
      };
      r.facts.forEach(push);
      for (const e of r.events) {
        evCols.uid.push(Number(v.user_id));
        evCols.type.push(e.type);
        evCols.data.push(e.data);
        evCols.ts.push(e.ts);
        evCols.pv.push(Number(v.id));
        evCols.attrs.push(e.attrs ? JSON.stringify(e.attrs) : null);
      }
    }

    const ids = versions.rows.map((v) => Number(v.id));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM fact WHERE profile_version_id = ANY($1::bigint[])', [ids]);
      await client.query('DELETE FROM segment_membership WHERE profile_version_id = ANY($1::bigint[])', [ids]);
      if (segCols.pv.length) {
        await client.query(
          `INSERT INTO segment_membership (profile_version_id, user_id, key, member, label, valid_from, valid_to)
           SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::boolean[], $5::text[], $6::timestamptz[], $7::timestamptz[])`,
          [segCols.pv, segCols.uid, segCols.key, segCols.member, segCols.label, segCols.from, segCols.to],
        );
        stats.segmentsWritten += segCols.pv.length;
      }
      if (factCols.pv.length) {
        await client.query(
          `INSERT INTO fact (profile_version_id, user_id, key, dim, kind, num, bool, text, ts, valid_from, valid_to)
           SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::float8[], $7::boolean[], $8::text[], $9::timestamptz[], $10::timestamptz[], $11::timestamptz[])`,
          [factCols.pv, factCols.uid, factCols.key, factCols.dim, factCols.kind, factCols.num, factCols.bool, factCols.text, factCols.ts, factCols.from, factCols.to],
        );
      }
      if (evCols.uid.length) {
        const r = await client.query(
          `INSERT INTO event (user_id, type, data, ts, first_seen_version_id, attrs)
           SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::timestamptz[], $5::bigint[], $6::jsonb[])
           ON CONFLICT (user_id, type, data, ts) DO NOTHING`,
          [evCols.uid, evCols.type, evCols.data, evCols.ts, evCols.pv, evCols.attrs],
        );
        stats.eventsWritten += r.rowCount ?? 0;
      }
      await client.query('UPDATE profile_version SET extracted_at = now(), config_hash = $2 WHERE id = ANY($1::bigint[])', [ids, hash]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    stats.versionsExtracted += ids.length;
    stats.factsWritten += factCols.pv.length;
    log.info(`extracted ${stats.versionsExtracted} versions, ${stats.factsWritten} facts, ${stats.segmentsWritten} segment rows, ${stats.eventsWritten} new events`);
  }
  for (const [k, m] of Object.entries(stats.errors)) log.warn(`${k.startsWith('mount ') || k.startsWith('segment ') ? k : `fact ${k}`}: ${m}`);
  return stats;
}

/** (Re)create the wide views for the current facts config. */
export async function applyViews(pool: Pool, config: PulseConfig): Promise<{ changed: boolean; hash: string }> {
  const hash = extractConfigHash(config);
  const current = await pool.query<{ hash: string }>(`SELECT hash FROM applied_config WHERE name = 'views'`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of wideViewSql(config.facts, config.segments)) await client.query(sql);
    await client.query(
      `INSERT INTO applied_config (name, hash, body) VALUES ('views', $1, $2)
       ON CONFLICT (name) DO UPDATE SET hash = EXCLUDED.hash, applied_at = now(), body = EXCLUDED.body`,
      [hash, JSON.stringify({ facts: config.facts.map((f) => ({ key: f.key, shape: f.shape, semantics: f.semantics })), segments: config.segments.map((s) => ({ key: s.key, kind: s.label ? 'label' : 'boolean' })) })],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { changed: current.rows[0]?.hash !== hash, hash };
}
