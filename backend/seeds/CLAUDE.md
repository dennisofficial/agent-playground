# Dev seed plan (Atlas v3 rebuild)

> The seed files in this folder (`000`–`004`) are from the **old** schema — they import entities from
> `src/app_old/persistence` and reference tables (repos, credentials, convention_profiles) that the
> rebuilt backend does not have yet. They will be **rewritten per-slice** as each entity lands. Don't
> run `pnpm db:seed` against the new schema until the seeds below are ported.

## Target seed shape (build incrementally, as the entities exist)

Seed **one organization** ("Atlas Test", owned by the dev admin) with **two repos**:

1. **Real repo** — `dennisofficial/test-repo` (`https://github.com/dennisofficial/test-repo`), the
   existing throwaway GitHub repo. Seeded `access_ok: true` (the dev PAT reaches it). Used for **real
   SDK turns** — so **do NOT seed it with jobs/threads/transcripts**; that's live work the operator drives.

2. **Fake repo** — a fully **synthetic** repo used for UI/dev without touching GitHub or the engine:
   **fake everything** — fake thread groups, fake threads/jobs, fake transcripts (messages, tool calls,
   live-turn frames), fake pipeline/diff/context. This is the fixture repo for building and demoing the
   workspace UI before the engine is rebuilt.

## Sequencing (which slice unlocks which seed)

- **Now (exists):** user + org + owner membership. (Admin user is already provisioned on boot via
  `AuthService.onApplicationBootstrap` from `ADMIN_SEED_*`; the org/membership seed can be ported now.)
- **After the `repo` slice:** seed both repo rows (real `access_ok:true`, fake).
- **After the `thread`/`job` + transcript slices:** seed the fake repo's thread groups, threads, and
  fake transcripts. Keep it **additive + idempotent** (stable ids via `_shared/dev-seed-ids.ts`), and
  **never** touch the real repo's rows (mirror the old `001-dev-org` non-destructive contract).

## Notes

- Fresh baseline: entities are co-located per feature module (`src/app/<feature>/entities`); seeds should
  import them from there, not from a central barrel.
- Org has **no slug** and uses three boolean automation defaults (`defaultAutoApprove` / `defaultAutoShip`
  / `defaultAutoMerge`) — update the org seed accordingly when porting `001`.
