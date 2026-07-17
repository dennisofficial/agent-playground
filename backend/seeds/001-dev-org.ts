import type { Seeder } from '@workspace/nestjs-core';
import {
  OrganizationEntity,
  OrganizationMemberEntity,
  UserEntity,
} from '../src/app_old/persistence/entities';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

/**
 * Dev org fixtures — ensures the single demo organization the dev user OWNS exists so a FRESH database has an
 * org rail + "All organizations" board to render, and so `003-dev-credentials` has an org to attach the
 * seeded credentials to.
 *
 * NON-DESTRUCTIVE + ADDITIVE ONLY. This seed NEVER deletes or resets anything: it does not touch repos,
 * jobs, threads, or messages, and it does not create fake jobs. It only creates a demo org when that org
 * id is ABSENT (on a fresh DB), and ensures the owner membership. On a DB that already has these orgs (the
 * normal case — you connect your real repos + run real jobs under them), it is a pure no-op that leaves
 * every repo/job/conversation exactly as-is.
 *
 * (History: an earlier version live-probed GitHub, created placeholder jobs, and `repos.delete`/reset-wiped
 * each org's rows every run — which destroyed real connected repos + job conversations. Removed entirely.)
 */
export default (async (ds) => {
  const users = ds.getRepository(UserEntity);
  const ownerEmail =
    process.env.SEED_OWNER_EMAIL ?? process.env.ADMIN_SEED_EMAIL ?? 'dennislysenko@hotmail.com';

  let owner = await users.findOne({ where: { email: ownerEmail } });
  if (!owner) {
    const [first] = await users.find({ order: { created_at: 'ASC' }, take: 1 });
    owner = first ?? null;
  }
  if (!owner) {
    console.log('  001: no users found — run 000-dev-user (set ADMIN_SEED_*) first');
    return;
  }

  const orgs = ds.getRepository(OrganizationEntity);
  const members = ds.getRepository(OrganizationMemberEntity);

  const SPEC = [{ id: DEV_SEED_IDS.orgs.atlasTest, name: 'Atlas Test', slug: 'atlas-test' }];

  for (const o of SPEC) {
    const existing = await orgs.findOne({ where: { id: o.id } });
    if (!existing) {
      await orgs.save(orgs.create({ id: o.id, name: o.name, slug: o.slug, status: 'active' }));
      console.log(`  001: created demo org "${o.name}"`);
    } else {
      console.log(
        `  001: org "${existing.name}" already exists — left untouched (repos/jobs preserved)`,
      );
    }

    // Ensure the dev user owns it (idempotent; never removes an existing membership).
    const mem = await members.findOne({
      where: { org_id: o.id, user_id: owner.id },
    });
    if (!mem)
      await members.save(members.create({ org_id: o.id, user_id: owner.id, role: 'owner' }));
  }
}) satisfies Seeder;
