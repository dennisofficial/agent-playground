import type { Seeder } from '@workspace/nestjs-core';
import { RepoEntity } from '../src/app/persistence/entities';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

/**
 * The single dev repo — a throwaway GitHub repo (`dennisofficial/test-repo`) dedicated to Atlas so
 * local test runs never touch real branches. Mirrors the row shape `OnboardingService.connectRepo`
 * writes (slug/name/git_url/default_branch/token_name), but inserted directly here so a fresh
 * `pnpm db:seed` yields an org that already has a repo to run jobs against.
 *
 * `access_ok` is seeded TRUE: `dennisofficial/test-repo` is a real repo the seeded GitHub PAT can
 * reach, so we mark it pre-verified rather than deferring to a first-job probe. (The runtime still
 * re-validates on demand — a "Re-validate" action or a rotated PAT re-runs `revalidateRepo`.)
 *
 * Because the row is inserted directly (not via `connectRepo`), the automatic repo-onboarding thread
 * (which authors `.atlas/worktree.json`) is NOT spawned — that's fine (onboarding is optional for
 * running jobs and can be re-triggered later). Idempotent via the stable id / `(org_id, slug)`.
 */
export default (async (ds) => {
  const repos = ds.getRepository(RepoEntity);
  const org_id = DEV_SEED_IDS.orgs.atlasTest;
  const slug = 'test-repo';

  const existing =
    (await repos.findOne({ where: { id: DEV_SEED_IDS.repos.testRepo } })) ??
    (await repos.findOne({ where: { org_id, slug } }));

  const row = existing ?? repos.create({ id: DEV_SEED_IDS.repos.testRepo, org_id, slug });
  row.name = 'test-repo';
  row.git_url = 'https://github.com/dennisofficial/test-repo';
  row.default_branch = 'main';
  row.token_name = null;
  row.access_ok = true; // real repo, seeded PAT reaches it — mark pre-verified
  row.access_checked_at = new Date();
  await repos.save(row);
  console.log(`  002: seeded repo ${slug} → org ${org_id}`);
}) satisfies Seeder;
