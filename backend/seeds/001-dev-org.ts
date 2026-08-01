import { EOrgRole, EOrgStatus } from '@workspace/shared';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';
import type { Seeder } from './_shared/seeder';

/**
 * Dev org fixture — the single demo organization the dev user OWNS, so a fresh DB renders an org rail +
 * workspace. New v3 schema: no slug, `status` enum, three boolean automation defaults (left at their
 * column defaults here).
 *
 * NON-DESTRUCTIVE + ADDITIVE ONLY: creates the org only when its id is absent, and ensures the owner
 * membership. On a DB that already has it (you've connected real repos / run real jobs under it) it is a
 * pure no-op — it never resets repos, jobs, threads, or memberships.
 */
export default (async (prisma) => {
  const ownerEmail =
    process.env.SEED_OWNER_EMAIL ?? process.env.ADMIN_SEED_EMAIL ?? 'dennislysenko@hotmail.com';

  let owner = await prisma.user.findFirst({ where: { email: ownerEmail } });
  if (!owner) {
    owner = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  }
  if (!owner) {
    console.log('  001: no users found — run 000-dev-user (set ADMIN_SEED_*) first');
    return;
  }

  const id = DEV_SEED_IDS.orgs.atlasTest;

  if (!(await prisma.organization.findFirst({ where: { id } }))) {
    await prisma.organization.create({ data: { id, name: 'Atlas Test', status: EOrgStatus.ACTIVE } });
    console.log('  001: created demo org "Atlas Test"');
  } else {
    console.log('  001: org "Atlas Test" already exists — left untouched');
  }

  // Ensure the dev user owns it (idempotent; never removes an existing membership).
  if (!(await prisma.organizationMember.findFirst({ where: { orgId: id, userId: owner.id } }))) {
    await prisma.organizationMember.create({ data: { orgId: id, userId: owner.id, role: EOrgRole.OWNER } });
  }
}) satisfies Seeder;
