import 'dotenv/config'; // PULSE_TEST_DATABASE_URL from .env enables the Postgres integration suites
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    // Integration suites share one Postgres database; keep files sequential.
    fileParallelism: false,
  },
});
