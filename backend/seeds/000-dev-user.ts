import { hash } from '@node-rs/argon2';
import type { Seeder } from '@dltech/nestjs-core';
import { EUserRole, EUserStatus } from '@workspace/shared';
import { User } from '../src/_lib/database/entities/user.entity';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

export default (async (ds) => {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!email || !password) {
    console.log('  000: ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD not set — skipping dev user');
    return;
  }

  const users = ds.getRepository(User);
  if (await users.findOne({ where: { email } })) {
    console.log(`  000: dev user ${email} already exists, skipping`);
    return;
  }

  await users.save(
    users.create({
      id: DEV_SEED_IDS.users.dennis,
      email,
      name: 'Admin',
      passwordHash: await hash(password),
      role: EUserRole.ADMIN,
      status: EUserStatus.ACTIVE,
    }),
  );
  console.log(`  000: seeded dev user ${email}`);
}) satisfies Seeder;
