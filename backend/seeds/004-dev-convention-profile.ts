import type { Seeder } from '@workspace/nestjs-core';
import { ConventionProfileEntity } from '../src/app/persistence/entities';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

/**
 * The dev org's reusable house-style profile — Dennis's standard NestJS-backend + Next.js-frontend +
 * shared-contract layout. Seeded so `list_convention_profiles` has something to match against and the
 * onboarding brain can `propose_convention_profile('nestjs-next-shared')` on a matching repo. A repo only
 * adopts it once its `convention_profile_slug` is set (owner-approved) — seeding the profile does NOT attach
 * it to any repo. Idempotent via the composite PK `(org_id, slug)`.
 */
export default (async (ds) => {
  const profiles = ds.getRepository(ConventionProfileEntity);
  const org_id = DEV_SEED_IDS.orgs.atlasTest;
  const slug = 'nestjs-next-shared';

  const row =
    (await profiles.findOne({ where: { org_id, slug } })) ??
    profiles.create({ org_id, slug });
  row.name = 'NestJS + Next.js + shared contract';
  row.detect_hint =
    'A pnpm/turbo monorepo (or paired repos) with a NestJS backend AND a Next.js frontend, wired together ' +
    'through a shared/ directory that holds the cross-boundary contract (DTOs, types, zod/validation ' +
    'schemas). Match this when you see @nestjs/* in the backend, next in the frontend, and a shared/ (or ' +
    'packages/shared) package imported by both. Do NOT match a backend-only, a non-Next frontend, or a repo ' +
    'with no shared contract layer.';
  row.body = [
    '# House style: NestJS + Next.js + shared contract',
    '',
    '## Backend (NestJS)',
    '- Follow NestJS best practices: one feature = one module; controllers stay thin and delegate to',
    '  providers/services; use dependency injection (ports-as-tokens) rather than global singletons or facades.',
    '- Keep domain logic in services; keep HTTP/transport concerns in controllers.',
    '',
    '## Frontend (Next.js)',
    '- Folder structure: `apps/` for page-level "views"/routes, feature folders for cohesive feature code,',
    '  an atomic `components/` folder for shared presentational components, and a `libs/` folder for',
    '  cross-feature utilities/clients.',
    '- Follow Next.js conventions (RSC/client boundaries, data fetching, metadata) as the framework intends.',
    '',
    '## The shared contract',
    '- Treat the `shared/` directory as the SINGLE source of truth for the contract between backend and',
    '  frontend — DTOs, shared types, and validation schemas live there and are imported by both sides.',
    '- When a backend endpoint changes shape, update the shared contract and let both ends consume it; do not',
    '  duplicate types on either side.',
  ].join('\n');
  await profiles.save(row);
  console.log(`  004: seeded convention profile ${slug} → org ${org_id}`);
}) satisfies Seeder;
