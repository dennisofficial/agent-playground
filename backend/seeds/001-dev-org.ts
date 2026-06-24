import type { Seeder } from '@workspace/nestjs-core';
import {
  OrganizationEntity,
  OrganizationMemberEntity,
  RepoEntity,
  ThreadEntity,
  UserEntity,
} from '../src/app/persistence/entities';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

/**
 * Dev fixtures for the multi-org operator console — two organizations the dev user OWNS, each with a
 * connected repo and a couple of threads, so the "All organizations" board, the org rail, the filter
 * chip, and the Org & Settings page all have real data to render.
 *
 * The orgs attach to the dev user from `000-dev-user` (looked up by `ADMIN_SEED_EMAIL`, falling back to
 * the first user) — this seed never touches credentials. Id-authoritative: each org keeps its fixed id
 * from `dev-seed-ids.ts` so it stays stable across db rebuilds. If an org with the same slug already
 * exists under a DIFFERENT id (a fixture seeded before the id changed), it's replaced.
 */
export default (async (ds) => {
  const users = ds.getRepository(UserEntity);
  const ownerEmail = process.env.SEED_OWNER_EMAIL ?? process.env.ADMIN_SEED_EMAIL ?? 'dennislysenko@hotmail.com';

  let owner = await users.findOne({ where: { email: ownerEmail } });
  if (!owner) {
    const [first] = await users.find({ order: { created_at: 'ASC' }, take: 1 });
    owner = first ?? null;
  }
  if (!owner) {
    console.log('  001: no users found — run 000-dev-user (set ADMIN_SEED_*) first');
    return;
  }
  console.log(`  001: attaching seed orgs to user ${owner.email}`);

  const orgs = ds.getRepository(OrganizationEntity);
  const members = ds.getRepository(OrganizationMemberEntity);
  const repos = ds.getRepository(RepoEntity);
  const threads = ds.getRepository(ThreadEntity);

  const SPEC = [
    {
      id: DEV_SEED_IDS.orgs.hannibal,
      name: 'Hannibal AI',
      slug: 'hannibal-ai',
      repo: 'web',
      threads: [
        { id: DEV_SEED_IDS.threads.hannibalAuthGuard, origin: 'control', title: 'Refactor auth guard', branch: 'feat/auth-guard' },
        { id: DEV_SEED_IDS.threads.hannibalCiEvent, origin: 'event', title: 'CI failed: e2e poll', branch: 'main' },
      ],
    },
    {
      id: DEV_SEED_IDS.orgs.cubix,
      name: 'Cubix Hosts',
      slug: 'cubix-hosts',
      repo: 'infra',
      threads: [
        { id: DEV_SEED_IDS.threads.cubixStripe, origin: 'chat', title: 'Stripe billing webhooks', branch: 'feat/stripe' },
        { id: DEV_SEED_IDS.threads.cubixAllergen, origin: 'event', title: 'Sentry: 500s on /upload', branch: 'main' },
      ],
    },
  ];

  for (const o of SPEC) {
    // Id-authoritative: the fixed id from dev-seed-ids.ts is canonical (stable across db rebuilds). If an
    // org with this slug exists under a DIFFERENT id (a fixture seeded before the id changed), replace it
    // — these are seed-only orgs, so the rows we re-seed are their only dependents.
    const stale = await orgs.findOne({ where: { slug: o.slug } });
    if (stale && stale.id !== o.id) {
      await threads.delete({ org_id: stale.id });
      await repos.delete({ org_id: stale.id });
      await members.delete({ org_id: stale.id });
      await orgs.delete({ id: stale.id });
    }

    await orgs.save(orgs.create({ id: o.id, name: o.name, slug: o.slug, status: 'active' }));
    await members.save(members.create({ org_id: o.id, user_id: owner.id, role: 'owner' }));
    // Repos now have a surrogate uuid id (DB-generated) + an org-unique slug. Find-or-create so a
    // re-seed doesn't collide on UNIQUE(org_id, slug); capture the id for the thread FKs.
    let repo = await repos.findOne({ where: { org_id: o.id, slug: o.repo } });
    if (!repo) {
      repo = await repos.save(
        repos.create({
          org_id: o.id,
          slug: o.repo,
          name: o.repo,
          git_url: `https://github.com/${o.slug}/${o.repo}.git`,
          default_branch: 'main',
          access_ok: true,
          access_checked_at: new Date(),
        }),
      );
    }
    for (const t of o.threads) {
      await threads.save(
        threads.create({
          id: t.id,
          org_id: o.id,
          repo_id: repo.id,
          origin: t.origin,
          title: t.title,
          base_branch: t.branch,
          surface_thread_ref: null,
        }),
      );
    }
    console.log(`  001: seeded org "${o.name}" (repo ${o.repo}, ${o.threads.length} threads)`);
  }
}) satisfies Seeder;
