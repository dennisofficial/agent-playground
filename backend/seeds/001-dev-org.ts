import type { Seeder } from '@workspace/nestjs-core';
import { In } from 'typeorm';
import {
  MessageEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
  RepoEntity,
  ThreadEntity,
  UserEntity,
} from '../src/app/persistence/entities';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

/**
 * Dev fixtures for the multi-org operator console — two organizations the dev user OWNS, each with a real
 * connected GitHub repo and a couple of threads, so the "All organizations" board, the org rail, the
 * filter chip, and the Org & Settings page (incl. the Repos tab) all have real data to render.
 *
 * Repos are REAL GitHub repos under orgs that map to the seeded orgs, and access is validated LIVE at
 * seed time with the dev `GITHUB_TOKEN`/`GITHUB_PAT` (mirrors the real connect-repo probe) — so
 * `access_ok` + `access_checked_at` + `default_branch` reflect reality, not a hardcoded `true`. With no
 * token set, repos seed with `access_ok=false` (exactly what the UI would show before a token is added).
 *
 * The orgs attach to the dev user from `000-dev-user` (looked up by `ADMIN_SEED_EMAIL`, falling back to
 * the first user) — this seed never touches credentials. Id-authoritative: each org keeps its fixed id
 * from `dev-seed-ids.ts` so it stays stable across db rebuilds. If an org with the same slug already
 * exists under a DIFFERENT id (a fixture seeded before the id changed), it's replaced. Each run resets
 * the org's repos + threads to this spec (idempotent; the live schema has no FK constraints).
 */

const GH_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT;

/** Probe a repo's reachability with the dev token (same check the connect flow does), best-effort. */
async function probeRepoAccess(
  owner: string,
  repo: string,
): Promise<{ ok: boolean; defaultBranch?: string }> {
  if (!GH_TOKEN) return { ok: false };
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        authorization: `Bearer ${GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'atlas-dev-seed',
      },
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { default_branch?: string };
    return { ok: true, defaultBranch: body.default_branch };
  } catch {
    return { ok: false };
  }
}

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
  if (!GH_TOKEN) {
    console.log('  001: no GITHUB_TOKEN/GITHUB_PAT — repos will seed with access_ok=false');
  }

  const orgs = ds.getRepository(OrganizationEntity);
  const members = ds.getRepository(OrganizationMemberEntity);
  const repos = ds.getRepository(RepoEntity);
  const threads = ds.getRepository(ThreadEntity);
  const messages = ds.getRepository(MessageEntity);

  const SPEC = [
    {
      id: DEV_SEED_IDS.orgs.hannibal,
      name: 'Hannibal AI',
      slug: 'hannibal-ai',
      // Real repo under the HannibalAI GitHub org.
      repo: { owner: 'HannibalAI', name: 'ortho-backend-v3' },
      threads: [
        { id: DEV_SEED_IDS.threads.hannibalAuthGuard, origin: 'control', title: 'Refactor auth guard', branch: 'feat/auth-guard' },
        { id: DEV_SEED_IDS.threads.hannibalCiEvent, origin: 'event', title: 'CI failed: e2e poll', branch: 'main' },
      ],
    },
    {
      id: DEV_SEED_IDS.orgs.cubix,
      name: 'Cubix Hosts',
      slug: 'cubix-hosts',
      // Real repo under the CubixHosts GitHub org.
      repo: { owner: 'CubixHosts', name: 'cubix-infra' },
      threads: [
        { id: DEV_SEED_IDS.threads.cubixStripe, origin: 'chat', title: 'Stripe billing webhooks', branch: 'feat/stripe' },
        { id: DEV_SEED_IDS.threads.cubixAllergen, origin: 'event', title: 'Sentry: 500s on /upload', branch: 'main' },
      ],
    },
  ];

  // Wipe a thread's messages + the threads themselves for an org (no FKs ⇒ fixed-id threads would
  // otherwise re-attach stale messages on recreate).
  const resetOrgThreads = async (orgId: string): Promise<void> => {
    const existing = await threads.find({ where: { org_id: orgId } });
    if (existing.length) await messages.delete({ thread_id: In(existing.map((t) => t.id)) });
    await threads.delete({ org_id: orgId });
  };

  for (const o of SPEC) {
    // Id-authoritative: the fixed id from dev-seed-ids.ts is canonical (stable across db rebuilds). If an
    // org with this slug exists under a DIFFERENT id (a fixture seeded before the id changed), replace it
    // — these are seed-only orgs, so the rows we re-seed are their only dependents.
    const stale = await orgs.findOne({ where: { slug: o.slug } });
    if (stale && stale.id !== o.id) {
      await resetOrgThreads(stale.id);
      await repos.delete({ org_id: stale.id });
      await members.delete({ org_id: stale.id });
      await orgs.delete({ id: stale.id });
    }

    await orgs.save(orgs.create({ id: o.id, name: o.name, slug: o.slug, status: 'active' }));
    await members.save(members.create({ org_id: o.id, user_id: owner.id, role: 'owner' }));

    // Reset this org's repos + threads to the spec so a re-seed is deterministic regardless of prior
    // (possibly differently-slugged) fixtures.
    await resetOrgThreads(o.id);
    await repos.delete({ org_id: o.id });

    // Connect the real repo, validating access live with the dev GitHub token.
    const access = await probeRepoAccess(o.repo.owner, o.repo.name);
    const repo = await repos.save(
      repos.create({
        org_id: o.id,
        slug: o.repo.name,
        name: o.repo.name,
        git_url: `https://github.com/${o.repo.owner}/${o.repo.name}.git`,
        default_branch: access.defaultBranch ?? 'main',
        access_ok: access.ok,
        access_checked_at: new Date(),
      }),
    );

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
    console.log(
      `  001: seeded org "${o.name}" → ${o.repo.owner}/${o.repo.name} (access_ok=${access.ok}, ${o.threads.length} threads)`,
    );
  }
}) satisfies Seeder;
