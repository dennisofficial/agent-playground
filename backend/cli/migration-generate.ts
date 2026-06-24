import { execFileSync } from 'child_process';

/**
 * Twin of `cli/migration-generate.ts`, but for Atlas v2's OWN datasource — generates into
 * `migrations/` off `cli/data-source.ts` (the `app` schema, history in
 * `migrations`). The initial migration is hand-written (pgvector + brand-new datasource); the
 * generator takes over from migration #2. Usage: `pnpm db:migration:generate <Name>`.
 */
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
if (!name) {
  console.error(
    'Error: migration name required.\n  Usage: pnpm db:migration:generate <Name>',
  );
  process.exit(1);
}

execFileSync(
  'typeorm-ts-node-commonjs',
  ['migration:generate', `migrations/${name}`, '-d', 'cli/data-source.ts'],
  { stdio: 'inherit' },
);
