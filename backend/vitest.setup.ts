import { config } from '@dotenvx/dotenvx';
import { existsSync } from 'node:fs';

// Local secrets first (git-ignored; present locally for *.ai.test.ts, supplied via the
// environment in CI), THEN the encrypted test env (committed, non-secret config) so the
// test tier is AUTHORITATIVE for every key it defines. Order is load-bearing: .env.personal
// also holds the dev-server Postgres coordinates, and the test tier must win over those —
// int tests TRUNCATE tables, and pointing them at the dev database wipes the team's live
// memory (facts/board/reminders/worklog). That happened once; never again.
if (existsSync('.env.personal')) {
  config({ path: '.env.personal', logLevel: 'error', overload: true });
}
config({ path: '.env.test.enc', strict: true, logLevel: 'error', overload: true });

// Hard guard: tests only ever run against a dedicated *_test database, no matter how the
// env layers resolve. vitest.global-setup.ts creates + migrates it on demand.
if (!process.env.POSTGRES_DB?.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests: POSTGRES_DB="${process.env.POSTGRES_DB ?? ''}" is not a *_test database. ` +
      'Int tests TRUNCATE tables — they must never share a database with the dev harness. ' +
      'Fix the env layering (.env.test.enc defines the test database) instead of overriding this.',
  );
}

// Harness-migration TODO: once @langchain lands in the backend, extend matchers
// here (e.g. `expect.extend(langchainMatchers)` from '@langchain/core/testing')
// and wire LangSmith tracing for *.ai.test.ts — this project traces via LangSmith,
// not Langfuse (see mls-studio for the Langfuse/OTEL variant of this hook).
