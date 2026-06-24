/**
 * Stable UUIDs for the dev seed so re-running `pnpm db:seed` is idempotent (upsert by PK, never a
 * duplicate). Dev-only fixtures — never referenced by app code or migrations.
 */
export const DEV_SEED_IDS = {
  users: {
    dennis: '1e512337-cd7e-41bb-8485-565eed283139',
    nadia: '7c4d2a91-3e6b-4f08-9a1d-2b5c8e0f4a63',
  },
  orgs: {
    hannibal: 'e9af869c-309a-466e-ba1b-51b870106b3f',
    cubix: '6899f4d7-2a30-4def-a170-fb182d1841f7',
  },
  threads: {
    hannibalAuthGuard: '04513c7b-8c22-4b21-9c38-08884f5357dd',
    hannibalCiEvent: '357db7a1-af4f-4031-87ec-9b3352d6fd24',
    cubixAllergen: 'de50edaa-a0d3-479b-be91-5b8b658150c6',
    cubixStripe: 'b60a539b-b4cf-4b5f-9e08-7d26269928bf',
  },
} as const;
