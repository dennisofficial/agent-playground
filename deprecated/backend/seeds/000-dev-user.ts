import { hash } from '@node-rs/argon2';
import { EUserRole, EUserStatus } from '@workspace/shared';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';
import type { Seeder } from './_shared/seeder';

export default (async (prisma) => {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!email || !password) {
    console.log('  000: ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD not set — skipping dev user');
    return;
  }

  if (await prisma.user.findFirst({ where: { email } })) {
    console.log(`  000: dev user ${email} already exists, skipping`);
    return;
  }

  await prisma.user.create({
    data: {
      id: DEV_SEED_IDS.users.dennis,
      email,
      name: 'Admin',
      passwordHash: await hash(password),
      role: EUserRole.ADMIN,
      status: EUserStatus.ACTIVE,
    },
  });
  console.log(`  000: seeded dev user ${email}`);
}) satisfies Seeder;
