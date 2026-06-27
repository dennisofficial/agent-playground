import { defineConfig } from 'vitest/config';

// Pure unit tests — no database, no engine boot. Everything that touches Postgres
// (engine.ts / db.ts / snapshot.ts / the bus / leader election) is exercised by the
// consuming app's integration suite; here we lock down the pure logic and the
// replication source's connection lifecycle (mocking pg-logical-replication).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
