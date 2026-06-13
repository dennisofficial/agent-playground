import { hash } from '@node-rs/argon2';
import type { Seeder } from '@workspace/nestjs-core';
import { AdminUser } from '@workspace/shared/schemas';
import { randomUUID } from 'node:crypto';

/**
 * Idempotent seed for the initial admin user.
 * Requires ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD in the environment.
 * If either is missing the seed is skipped — the DB stays clean.
 */
export default (async (ds) => {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;

  if (!email || !password) {
    console.log(
      '  ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD not set — skipping admin user seed',
    );
    return;
  }

  const repo = ds.getRepository(AdminUser);

  const existing = await repo.findOne({ where: { email } });
  if (existing) {
    console.log(`  admin user "${email}" already exists — skipping`);
    return;
  }

  const password_hash = await hash(password);
  const user = repo.create({
    id: randomUUID(),
    email,
    password_hash,
    name: null,
    role: 'admin',
  });
  await repo.save(user);
  console.log(`  ✓ admin user created: ${email}`);
}) satisfies Seeder;
