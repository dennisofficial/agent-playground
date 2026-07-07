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
  },
} as const;
