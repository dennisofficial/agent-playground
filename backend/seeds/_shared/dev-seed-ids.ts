/**
 * Stable UUIDs for the dev seed so re-running `pnpm db:seed` is idempotent (upsert by PK, never a
 * duplicate). Dev-only fixtures — never referenced by app code or migrations.
 */
export const DEV_SEED_IDS = {
  users: {
    dennis: '1e512337-cd7e-41bb-8485-565eed283139',
  },
  orgs: {
    atlasTest: 'e9af869c-309a-466e-ba1b-51b870106b3f',
  },
  repos: {
    testRepo: '63ad1635-966a-427f-8e52-9cc8a8ecfc8b',
    fixtures: 'b1d4f0a2-7c3e-4a19-9f6b-2e8c5a1d4f77',
  },
  jobs: {
    codexSdk: 'c358e0a1-c206-48f4-aab8-04e9d2a334e1',
  },
} as const;
