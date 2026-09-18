import type pg from 'pg';
import { dropAllObjects } from '../../src/db/client.js';

/** Drop every view and table in the public schema so migrations run from scratch on the test database. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await dropAllObjects(pool);
}
