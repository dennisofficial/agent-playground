import type { Seeder } from '@workspace/nestjs-core';
import { hash } from '@node-rs/argon2';
import { OrganizationMemberEntity, UserEntity } from '../src/app/persistence/entities';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

/**
 * A second operator who is a MEMBER (not owner) of Hannibal AI — so the Members tab has a real second
 * row and the owner-vs-member UI states (the `member` pill in settings, the hidden owner-only repo/org
 * actions, the rail's JOINED section) have real data. Depends on `001-dev-org` having created the org.
 *
 * Login password is `SEED_MEMBER_PASSWORD` ?? `ADMIN_SEED_PASSWORD` (so you can sign in as her to see
 * the member view); if neither is set she's still created — display-only — with a locked hash. Idempotent
 * (stable id, upsert membership).
 */
export default (async (ds) => {
  const users = ds.getRepository(UserEntity);
  const members = ds.getRepository(OrganizationMemberEntity);

  const email = 'nadia@hannibal.ai';
  const password = process.env.SEED_MEMBER_PASSWORD ?? process.env.ADMIN_SEED_PASSWORD;
  const password_hash = await hash(password ?? `locked-${DEV_SEED_IDS.users.nadia}`);

  let user = await users.findOne({ where: { id: DEV_SEED_IDS.users.nadia } });
  if (!user) user = await users.findOne({ where: { email } });

  if (user) {
    // Keep the existing id stable; only refresh the hash when a real password is configured.
    if (password) await users.update({ id: user.id }, { password_hash });
  } else {
    user = await users.save(
      users.create({
        id: DEV_SEED_IDS.users.nadia,
        email,
        name: 'Nadia Rivera',
        password_hash,
        role: 'operator',
      }),
    );
  }

  await members.save(
    members.create({ org_id: DEV_SEED_IDS.orgs.hannibal, user_id: user.id, role: 'member' }),
  );
  console.log(
    `  002: ${email} is a member of Hannibal AI` +
      (password ? ' (login with SEED_MEMBER_PASSWORD/ADMIN_SEED_PASSWORD)' : ' (no password set — display only)'),
  );
}) satisfies Seeder;
