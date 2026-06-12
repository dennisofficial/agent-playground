import { resolve } from 'path';
import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';

// Path aliases mirror tsconfig.json `paths`. swc.vite() compiles TS with decorator
// metadata (reads .swcrc) so NestJS DI works inside tests.
const alias = {
  '@core': resolve(__dirname, 'src/_core'),
  '@api': resolve(__dirname, 'src/api'),
  '@tui': resolve(__dirname, 'src/tui'),
  '@harness': resolve(__dirname, 'src/harness'),
};

// Loads the local secret overlay + the encrypted test env (authoritative) before tests,
// and hard-refuses any POSTGRES_DB that isn't a dedicated *_test database.
const setupFiles = ['vitest.setup.ts'];
// Provisions + migrates the test database once per run (modes that touch Postgres).
const globalSetup = ['vitest.global-setup.ts'];

const base = {
  resolve: { alias },
  plugins: [swc.vite()],
};

/**
 * Test types, by filename convention:
 *   *.spec.ts       unit — fast, no app boot, no external services
 *   *.int.test.ts   integration — real local services (db/queue), no LLM calls
 *   *.e2e-spec.ts   e2e — boots the full Nest app, HTTP via supertest
 *   *.ai.test.ts    AI — real LLM provider calls (costs money, needs API keys)
 *
 * `pnpm test` runs everything EXCEPT *.ai.test.ts (those only run via `pnpm test:ai`,
 * so the default/CI run stays free, fast, and deterministic).
 */
export default defineConfig((env) => {
  // Real LLM calls. Single-threaded + long timeout. Run with: pnpm test:ai
  if (env.mode === 'ai') {
    return {
      ...base,
      test: {
        globals: true,
        environment: 'node',
        setupFiles,
        include: ['**/*.ai.test.ts'],
        testTimeout: 100_000,
        pool: 'threads',
        poolOptions: { threads: { singleThread: true } },
      },
    };
  }

  // NestJS e2e — boots the app, no external APIs. Run with: pnpm test:e2e
  if (env.mode === 'e2e') {
    return {
      ...base,
      test: {
        globals: true,
        environment: 'node',
        setupFiles,
        include: ['**/*.e2e-spec.ts'],
        globalSetup,
        testTimeout: 30_000,
        pool: 'threads',
        poolOptions: { threads: { singleThread: true } },
      },
    };
  }

  // Fast unit tests only. Run with: pnpm test:unit
  if (env.mode === 'unit') {
    return {
      ...base,
      test: {
        globals: true,
        environment: 'node',
        setupFiles,
        include: ['src/**/*.spec.ts'],
        exclude: ['**/*.int.test.ts', '**/*.e2e-spec.ts', '**/*.ai.test.ts', ...configDefaults.exclude],
      },
    };
  }

  // Default — unit + integration + e2e, but NOT real-LLM ai tests. Run with: pnpm test
  // Two projects: unit specs run fully parallel; the DB-touching int/e2e files run
  // single-threaded — they share the one *_test database and TRUNCATE the same tables,
  // so concurrently-running files corrupt each other's fixtures.
  return {
    ...base,
    test: {
      globalSetup,
      projects: [
        {
          ...base,
          test: {
            name: 'unit',
            globals: true,
            environment: 'node',
            setupFiles,
            include: ['src/**/*.spec.ts'],
            exclude: ['**/*.int.test.ts', '**/*.e2e-spec.ts', '**/*.ai.test.ts', ...configDefaults.exclude],
            testTimeout: 30_000,
          },
        },
        {
          ...base,
          test: {
            name: 'integration',
            globals: true,
            environment: 'node',
            setupFiles,
            include: ['**/*.int.test.ts', '**/*.e2e-spec.ts'],
            exclude: ['**/*.ai.test.ts', ...configDefaults.exclude],
            pool: 'threads',
            poolOptions: { threads: { singleThread: true } },
            testTimeout: 30_000,
          },
        },
      ],
    },
  };
});
