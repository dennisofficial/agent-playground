import { config } from '@dotenvx/dotenvx';
import { existsSync } from 'node:fs';

if (existsSync('.env.personal')) {
  config({ path: '.env.personal', logLevel: 'error', overload: true });
}
config({ path: '.env.test.enc', strict: true, logLevel: 'error', overload: true });

if (!process.env.POSTGRES_DB?.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests: POSTGRES_DB="${process.env.POSTGRES_DB ?? ''}" is not a *_test database. ` +
      'Int tests TRUNCATE tables — they must never share a database with the dev harness. ' +
      'Fix the env layering (.env.test.enc defines the test database) instead of overriding this.',
  );
}

// Harness-migration TODO: once @langchain lands in the backend, extend matchers
// here (e.g. `expect.extend(langchainMatchers)` from '@langchain/core/testing')
// and wire Langfuse tracing for *.ai.test.ts — this project traces via Langfuse.
