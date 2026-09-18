import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(databaseUrl = process.env.DATABASE_URL): Pool {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  return new pg.Pool({ connectionString: databaseUrl, max: 8 });
}

/** Database name of a postgres:// URL. */
export function databaseName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
}

/** The same server and credentials, another database. */
export function withDatabaseName(databaseUrl: string, name: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

/**
 * The demo tenant's URL: PULSE_DEMO_DATABASE_URL, else DATABASE_URL with the database
 * swapped for `pulse_demo`. Always a different database from the real one.
 */
export function demoDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.PULSE_DEMO_DATABASE_URL) return env.PULSE_DEMO_DATABASE_URL;
  return env.DATABASE_URL ? withDatabaseName(env.DATABASE_URL, 'pulse_demo') : undefined;
}

/** Create `name` on the server `adminUrl` points at, if it does not exist. Returns true when created. */
export async function ensureDatabase(adminUrl: string, name: string): Promise<boolean> {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount) return false;
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await admin.end();
  }
}

/** Drop every view and table in the public schema, so `migrate` starts from scratch. */
export async function dropAllObjects(pool: Pool): Promise<void> {
  await pool.query(`DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT table_name FROM information_schema.views WHERE table_schema = 'public' LOOP
        EXECUTE 'DROP VIEW IF EXISTS ' || quote_ident(r.table_name) || ' CASCADE';
      END LOOP;
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$`);
}
