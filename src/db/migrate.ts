/**
 * Schema management. Two kinds of file live under db/:
 *
 *   db/schema.sql                  the complete current schema; a fresh database loads it
 *   db/migrations/<version>.sql    one upgrade script per release, from the release before it
 *
 * A fresh database gets schema.sql and every migration recorded as applied (schema.sql
 * always reflects the newest one). An existing database applies the migrations it has not
 * seen, in version order. The newest migration is the one being developed until the
 * release is tagged, so it may change: when its content hash differs from what was
 * applied, it is applied again, which is why migrations are written idempotently. Any
 * older migration whose hash differs is an error: released migrations are frozen.
 *
 * Databases created by the pre-release numbered migrations (0001_core.sql ...) are
 * recognised and re-labelled as the 0.1.0 baseline without touching their data.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './client.js';

const DB_DIR = fileURLToPath(new URL('../../db', import.meta.url));

/** The development-era migrations that a 0.1.0 database was built from, in order. */
const LEGACY_MIGRATIONS = ['0001_core.sql', '0002_profiles_facts.sql', '0003_derived.sql', '0004_segments.sql', '0005_enrich_backfill.sql', '0006_version_time.sql', '0007_event_attrs.sql'];
const LEGACY_BASELINE = '0.1.0';

export interface MigrateOptions {
  schemaFile?: string;
  migrationsDir?: string;
}

export interface MigrationResult {
  /** Set when schema.sql was loaded into an empty database: its declared version. */
  baseline?: string;
  /** A pre-release numbered-migration database was re-labelled as the 0.1.0 baseline. */
  bootstrapped?: boolean;
  applied: string[];
  /** The head migration was re-applied because its content changed. */
  reapplied: string[];
  skipped: string[];
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The version declared on the first line of schema.sql: `-- rbx-pulse schema X.Y.Z`. */
export function schemaVersion(sql: string): string {
  const m = /^--\s*rbx-pulse schema\s+(\d+\.\d+\.\d+)\s*$/m.exec(sql.split('\n', 1)[0] ?? '');
  if (!m) throw new Error('db/schema.sql must start with a line like "-- rbx-pulse schema 0.1.0"');
  return m[1]!;
}

/** Version of a migration file, or undefined for files that are not migrations. */
export function migrationVersion(file: string): string | undefined {
  return /^(\d+\.\d+\.\d+)\.sql$/.exec(file)?.[1];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

const baselineName = (version: string): string => `schema@${version}`;

export async function migrate(pool: Pool, opts: MigrateOptions = {}): Promise<MigrationResult> {
  const schemaFile = opts.schemaFile ?? path.join(DB_DIR, 'schema.sql');
  const migrationsDir = opts.migrationsDir ?? path.join(DB_DIR, 'migrations');
  const schemaSql = await readFile(schemaFile, 'utf8');
  const version = schemaVersion(schemaSql);

  let files: string[];
  try {
    files = (await readdir(migrationsDir)).filter((f) => migrationVersion(f));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    files = [];
  }
  files.sort((a, b) => compareVersions(migrationVersion(a)!, migrationVersion(b)!));
  const newest = files[files.length - 1];
  if (newest && compareVersions(migrationVersion(newest)!, version) > 0) {
    throw new Error(`db/migrations/${newest} is newer than db/schema.sql (${version}); update the version line in schema.sql to match`);
  }
  const migrations = await Promise.all(files.map(async (name) => ({ name, sql: await readFile(path.join(migrationsDir, name), 'utf8') })));

  const result: MigrationResult = { applied: [], reapplied: [], skipped: [] };
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS hash TEXT');
    const rows = (await client.query<{ name: string; hash: string | null }>('SELECT name, hash FROM schema_migrations')).rows;

    // Pre-release databases: the numbered migrations add up to the 0.1.0 baseline.
    const legacy = rows.filter((r) => /^\d{4}_/.test(r.name)).map((r) => r.name);
    if (legacy.length) {
      const missing = LEGACY_MIGRATIONS.filter((m) => !legacy.includes(m));
      if (missing.length) {
        throw new Error(`this database was built with the pre-release migrations but is missing ${missing.join(', ')}; finish upgrading it with the previous version of rbx-pulse first`);
      }
      await client.query('BEGIN');
      await client.query('DELETE FROM schema_migrations WHERE name = ANY($1::text[])', [legacy]);
      await client.query('INSERT INTO schema_migrations (name, hash) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [baselineName(LEGACY_BASELINE), 'legacy']);
      await client.query('COMMIT');
      result.bootstrapped = true;
      rows.splice(0, rows.length, ...rows.filter((r) => !legacy.includes(r.name)), { name: baselineName(LEGACY_BASELINE), hash: 'legacy' });
    }

    const applied = new Map(rows.map((r) => [r.name, r.hash]));

    if (applied.size === 0) {
      // Empty database: load the whole schema and mark every migration as included.
      await client.query('BEGIN');
      try {
        await client.query(schemaSql);
        await client.query('INSERT INTO schema_migrations (name, hash) VALUES ($1, $2)', [baselineName(version), hashOf(schemaSql)]);
        for (const m of migrations) await client.query('INSERT INTO schema_migrations (name, hash) VALUES ($1, $2)', [m.name, hashOf(m.sql)]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`loading db/schema.sql failed: ${(err as Error).message}`);
      }
      result.baseline = version;
      return result;
    }

    for (const m of migrations) {
      const hash = hashOf(m.sql);
      const have = applied.get(m.name);
      if (have === hash) {
        result.skipped.push(m.name);
        continue;
      }
      if (have !== undefined && m.name !== newest) {
        throw new Error(`db/migrations/${m.name} was modified after it was applied here; released migrations are frozen. Put the change in a new migration for the next release.`);
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO schema_migrations (name, hash) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET hash = EXCLUDED.hash, applied_at = now()`,
          [m.name, hash],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
      }
      (have === undefined ? result.applied : result.reapplied).push(m.name);
    }
  } finally {
    client.release();
  }
  return result;
}
