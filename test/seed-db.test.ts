/**
 * The turn-key demo seeder, end to end into the test database (with `force`, since its
 * name lacks "demo"). Skipped unless PULSE_TEST_DATABASE_URL is set.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/demo/seed.js';
import { databaseName, demoDatabaseUrl, withDatabaseName } from '../src/db/client.js';

const url = process.env.PULSE_TEST_DATABASE_URL;

describe('database url helpers', () => {
  it('swap the database name and derive the demo url', () => {
    expect(databaseName('postgres://u:p@localhost:5433/pulse')).toBe('pulse');
    expect(withDatabaseName('postgres://u:p@localhost:5433/pulse', 'pulse_demo')).toBe('postgres://u:p@localhost:5433/pulse_demo');
    expect(demoDatabaseUrl({ DATABASE_URL: 'postgres://u:p@h/pulse' })).toBe('postgres://u:p@h/pulse_demo');
    expect(demoDatabaseUrl({ DATABASE_URL: 'postgres://u:p@h/pulse', PULSE_DEMO_DATABASE_URL: 'postgres://x@y/d' })).toBe('postgres://x@y/d');
    expect(demoDatabaseUrl({})).toBeUndefined();
  });
});

describe.skipIf(!url)('demo seed (Postgres integration)', () => {
  let pool: pg.Pool;
  const log = { info: () => {}, warn: (m: string) => console.warn(m) };
  const NOW = 1_789_700_000;
  const weeks = 3;
  const players = 40;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(() => pool.end());

  it('refuses a database whose name does not say demo', async () => {
    await expect(seedDemo({ databaseUrl: url!, adminUrl: url!, players: 5, weeks: 0, fraction: 0.3, seed: 1, dataDir: '.', configDir: 'examples/demo-game/config', log })).rejects.toThrow(/"demo" in its name/);
  });

  it('replays weekly syncs into a fresh database and enriches players', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'pulse-seed-'));
    const s = await seedDemo({ databaseUrl: url!, adminUrl: url!, players, weeks, fraction: 0.4, seed: 3, dataDir, configDir: path.resolve('examples/demo-game/config'), log, now: NOW, force: true });
    expect(s.created).toBe(false);
    expect(s.players).toBe(players);
    expect(s.runs).toBe(weeks + 1);
    expect(s.versions).toBeGreaterThan(players);
    expect(s.milestoneEvents).toBeGreaterThan(0);
    expect(s.events).toBeGreaterThan(0);
    expect(s.enriched).toBe(players);
    // Runs are spaced a week apart and end just before `now`.
    expect(Math.round((s.lastRunAt.getTime() - s.firstRunAt.getTime()) / 86_400_000)).toBe(7 * weeks);
    expect(NOW * 1000 - s.lastRunAt.getTime()).toBeLessThan(2 * 86_400_000);
    const one = async (sql: string) => Number((await pool.query(sql)).rows[0].n);
    expect(await one('SELECT count(*) AS n FROM v_player_current')).toBe(players);
    expect(await one('SELECT count(*) AS n FROM player WHERE username IS NOT NULL')).toBe(players);
    expect(await one(`SELECT count(*) AS n FROM observation WHERE observed_at > to_timestamp(${NOW})`)).toBe(0);
    expect(await one('SELECT count(DISTINCT date_trunc(\'day\', observed_at)) AS n FROM observation')).toBe(weeks + 1);
    expect(await one(`SELECT count(*) AS n FROM v_player_current WHERE purchase_count > 0`)).toBe(s.purchasers);
  });
});
