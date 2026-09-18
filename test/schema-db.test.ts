/**
 * Schema management against Postgres: fresh load, per-release migrations with a mutable
 * head, frozen older migrations, and the pre-release bootstrap. Skipped unless
 * PULSE_TEST_DATABASE_URL is set. Wipes the pulse tables first.
 */
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions, migrate, migrationVersion, schemaVersion } from '../src/db/migrate.js';
import { resetDatabase } from './helpers/db.js';

const url = process.env.PULSE_TEST_DATABASE_URL;
const SCHEMA = path.resolve('db/schema.sql');

/** Order-independent structural description of the public schema, excluding bookkeeping. */
async function structure(pool: pg.Pool): Promise<Record<string, unknown>> {
  const q = async (sql: string) => (await pool.query(sql)).rows as Record<string, unknown>[];
  const cols = await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name <> 'schema_migrations' ORDER BY 1, 2`);
  const idx = await q(`SELECT indexname, regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \\S+ ON', 'CREATE \\1INDEX ON') AS def FROM pg_indexes
                        WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1`);
  const cons = await q(`SELECT conrelid::regclass::text AS tbl, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
                         WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> 'schema_migrations' ORDER BY 1, 2, 3`);
  const views = await q(`SELECT viewname, definition FROM pg_views WHERE schemaname = 'public' ORDER BY 1`);
  return { cols, idx, cons, views };
}

describe('schema helpers', () => {
  it('parses versions and orders them numerically', () => {
    expect(schemaVersion('-- rbx-pulse schema 0.1.0\nCREATE TABLE x();')).toBe('0.1.0');
    expect(() => schemaVersion('CREATE TABLE x();')).toThrow(/must start with/);
    expect(migrationVersion('0.2.0.sql')).toBe('0.2.0');
    expect(migrationVersion('0002_old.sql')).toBeUndefined();
    expect(['0.10.0', '0.2.0', '1.0.0'].sort(compareVersions)).toEqual(['0.2.0', '0.10.0', '1.0.0']);
  });
});

describe.skipIf(!url)('schema management (Postgres integration)', () => {
  let pool: pg.Pool;
  let dir: string;
  let schemaFile: string;
  let migrationsDir: string;
  const names = async () => (await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  const hasColumn = async (table: string, col: string) =>
    Number((await pool.query(`SELECT count(*) AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, col])).rows[0].n) === 1;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await resetDatabase(pool);
    dir = await mkdtemp(path.join(tmpdir(), 'pulse-schema-'));
    schemaFile = path.join(dir, 'schema.sql');
    migrationsDir = path.join(dir, 'migrations');
  });
  afterAll(() => pool.end());

  it('loads schema.sql into an empty database and is then a no-op', async () => {
    const r = await migrate(pool);
    expect(r.baseline).toBe(schemaVersion(await readFile(SCHEMA, 'utf8')));
    expect(await names()).toEqual([`schema@${r.baseline}`]);
    const tables = (await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);
    expect(tables).toEqual(['applied_config', 'event', 'fact', 'milestone_event', 'observation', 'player', 'profile_version', 'schema_migrations', 'segment_membership', 'snapshot', 'stat_delta', 'sync_run']);
    expect((await pool.query(`SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.viewname)).toEqual(['v_fact_current', 'v_player_activity', 'v_segment_current']);
    const again = await migrate(pool);
    expect(again).toEqual({ applied: [], reapplied: [], skipped: [] });
  });

  it('applies a new release migration, re-applies the head when it changes, and freezes older ones', async () => {
    const base = await readFile(SCHEMA, 'utf8');
    await writeFile(schemaFile, base.replace(/^-- rbx-pulse schema .*$/m, '-- rbx-pulse schema 0.2.0'));
    await mkdir(migrationsDir);
    await writeFile(path.join(migrationsDir, '0.2.0.sql'), 'ALTER TABLE player ADD COLUMN IF NOT EXISTS t_a INT;\n');
    let r = await migrate(pool, { schemaFile, migrationsDir });
    expect(r.applied).toEqual(['0.2.0.sql']);
    expect(await hasColumn('player', 't_a')).toBe(true);

    // The head is still being developed: editing it re-applies it.
    await writeFile(path.join(migrationsDir, '0.2.0.sql'), 'ALTER TABLE player ADD COLUMN IF NOT EXISTS t_a INT;\nALTER TABLE player ADD COLUMN IF NOT EXISTS t_b INT;\n');
    r = await migrate(pool, { schemaFile, migrationsDir });
    expect(r.reapplied).toEqual(['0.2.0.sql']);
    expect(r.applied).toEqual([]);
    expect(await hasColumn('player', 't_b')).toBe(true);

    // A migration newer than schema.sql's declared version is refused.
    await writeFile(path.join(migrationsDir, '0.3.0.sql'), 'ALTER TABLE player ADD COLUMN IF NOT EXISTS t_c INT;\n');
    await expect(migrate(pool, { schemaFile, migrationsDir })).rejects.toThrow(/newer than db\/schema.sql/);
    await writeFile(schemaFile, base.replace(/^-- rbx-pulse schema .*$/m, '-- rbx-pulse schema 0.3.0'));
    r = await migrate(pool, { schemaFile, migrationsDir });
    expect(r.applied).toEqual(['0.3.0.sql']);
    expect(r.skipped).toEqual(['0.2.0.sql']);

    // Now 0.2.0 is no longer the head: changing it is an error.
    await writeFile(path.join(migrationsDir, '0.2.0.sql'), 'ALTER TABLE player ADD COLUMN IF NOT EXISTS t_z INT;\n');
    await expect(migrate(pool, { schemaFile, migrationsDir })).rejects.toThrow(/was modified after it was applied/);
    expect(await hasColumn('player', 't_z')).toBe(false);
  });

  it('a fresh database gets schema.sql plus every migration marked as included', async () => {
    await resetDatabase(pool);
    await writeFile(path.join(migrationsDir, '0.2.0.sql'), 'ALTER TABLE player ADD COLUMN IF NOT EXISTS t_a INT;\n');
    const r = await migrate(pool, { schemaFile, migrationsDir });
    expect(r.baseline).toBe('0.3.0');
    expect(await names()).toEqual(['0.2.0.sql', '0.3.0.sql', 'schema@0.3.0']);
    expect(await hasColumn('player', 't_a')).toBe(false); // schema.sql is authoritative; migrations are not run on top
    expect((await migrate(pool, { schemaFile, migrationsDir })).skipped).toEqual(['0.2.0.sql', '0.3.0.sql']);
  });

  it('re-labels a pre-release numbered-migration database as the 0.1.0 baseline', async () => {
    await resetDatabase(pool);
    await pool.query(await readFile(SCHEMA, 'utf8'));
    await pool.query(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const legacy = ['0001_core.sql', '0002_profiles_facts.sql', '0003_derived.sql', '0004_segments.sql', '0005_enrich_backfill.sql', '0006_version_time.sql', '0007_event_attrs.sql'];
    await pool.query(`INSERT INTO schema_migrations (name) SELECT unnest($1::text[])`, [legacy.slice(0, 5)]);
    await expect(migrate(pool)).rejects.toThrow(/missing 0006_version_time.sql, 0007_event_attrs.sql/);
    await pool.query(`INSERT INTO schema_migrations (name) SELECT unnest($1::text[])`, [legacy.slice(5)]);
    const players = await pool.query(`INSERT INTO player (user_id) VALUES (1) RETURNING user_id`);
    expect(players.rowCount).toBe(1);
    const r = await migrate(pool);
    expect(r.bootstrapped).toBe(true);
    expect(r.baseline).toBeUndefined();
    expect(await names()).toEqual(['schema@0.1.0']);
    expect(Number((await pool.query('SELECT count(*) AS n FROM player')).rows[0].n)).toBe(1);
  });

  it('fresh schema.sql matches the previous release upgraded through the migrations (when a release tag exists)', async () => {
    let tag: string | undefined;
    try {
      tag = execSync('git describe --tags --abbrev=0 --match "v*"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
    } catch {
      tag = undefined;
    }
    if (!tag) return; // nothing released yet
    const previous = execSync(`git show ${tag}:db/schema.sql`).toString();
    await resetDatabase(pool);
    await pool.query(previous);
    await pool.query(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), hash TEXT)`);
    await pool.query(`INSERT INTO schema_migrations (name, hash) VALUES ($1, 'x')`, [`schema@${schemaVersion(previous)}`]);
    await migrate(pool);
    const upgraded = await structure(pool);
    await resetDatabase(pool);
    await migrate(pool);
    expect(upgraded).toEqual(await structure(pool));
  });
});
