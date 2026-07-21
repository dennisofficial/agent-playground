import type { Seeder } from '@workspace/nestjs-core';
import { Repo } from '../src/_lib/database/entities/repo.entity';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

/**
 * Dev repo fixtures on the "Atlas Test" org — so the repos settings tab + create-job picker have content
 * without connecting anything. Both are seeded `accessOk: true` so they render as connected (GitHub access
 * probing is deferred to the GitHub module; this is a UI fixture, not a live probe).
 *
 *  1. `dennisofficial/test-repo` — the real throwaway GitHub repo (for real SDK turns once the engine is
 *     back). Do NOT seed jobs/threads on it — that's live work.
 *  2. `atlas-dev/fixtures` — a fully synthetic repo for UI/dev; its fake threads/transcripts get seeded
 *     later, once the thread/job slice exists.
 *
 * NON-DESTRUCTIVE + ADDITIVE: skips any repo whose id already exists.
 */
export default (async (ds) => {
  const repos = ds.getRepository(Repo);
  const orgId = DEV_SEED_IDS.orgs.atlasTest;

  const SPEC = [
    {
      id: DEV_SEED_IDS.repos.testRepo,
      slug: 'dennisofficial/test-repo',
      name: 'test-repo',
      gitUrl: 'https://github.com/dennisofficial/test-repo',
    },
    {
      id: DEV_SEED_IDS.repos.fixtures,
      slug: 'atlas-dev/fixtures',
      name: 'Fixtures',
      gitUrl: 'https://github.com/atlas-dev/fixtures',
    },
  ];

  for (const r of SPEC) {
    if (await repos.findOne({ where: { id: r.id } })) {
      console.log(`  002: repo ${r.slug} already exists — skipping`);
      continue;
    }
    await repos.save(
      repos.create({
        id: r.id,
        orgId,
        slug: r.slug,
        name: r.name,
        gitUrl: r.gitUrl,
        defaultBranch: 'main',
        accessOk: true,
        accessCheckedAt: new Date(),
        defaultAutoMergeMethod: 'squash',
        defaultAutoMergeDeleteBranch: true,
      }),
    );
    console.log(`  002: seeded repo ${r.slug}`);
  }
}) satisfies Seeder;
