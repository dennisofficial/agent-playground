import { execFileSync } from 'child_process';

/**
 * Twin of `cli/migration-generate.ts`, but for Atlas v2's OWN datasource — generates into
 * `migrations-atlas/` off `cli/atlas-data-source.ts` (the `atlas_*` schema, history in
 * `atlas_migrations`). The initial migration is hand-written (pgvector + brand-new datasource); the
 * generator takes over from migration #2. Usage: `pnpm db:atlas:migration:generate <Name>`.
 */
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
if (!name) {
  console.error(
    'Error: migration name required.\n  Usage: pnpm db:atlas:migration:generate <Name>',
  );
  process.exit(1);
}

execFileSync(
  'typeorm-ts-node-commonjs',
  ['migration:generate', `migrations-atlas/${name}`, '-d', 'cli/atlas-data-source.ts'],
  { stdio: 'inherit' },
);
