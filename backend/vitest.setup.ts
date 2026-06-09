import { config } from '@dotenvx/dotenvx';
import { existsSync } from 'node:fs';

// Load the encrypted test env (committed, non-secret config) and overlay local
// secrets from .env.personal (git-ignored; present locally for *.ai.test.ts, and
// supplied via the environment in CI). Mirrors the env:inject the running apps use.
config({ path: '.env.test.enc', strict: true, logLevel: 'error', overload: true });
if (existsSync('.env.personal')) {
  config({ path: '.env.personal', logLevel: 'error', overload: true });
}

// Harness-migration TODO: once @langchain lands in the backend, extend matchers
// here (e.g. `expect.extend(langchainMatchers)` from '@langchain/core/testing')
// and wire LangSmith tracing for *.ai.test.ts — this project traces via LangSmith,
// not Langfuse (see mls-studio for the Langfuse/OTEL variant of this hook).
