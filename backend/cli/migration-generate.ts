import { execFileSync } from 'child_process';

// `--control` targets the control-plane datasource (gateway `tenants` DB) + its own folder.
const args = process.argv.slice(2);
const control = args.includes('--control');
const name = args.find((a) => !a.startsWith('--'));
if (!name) {
  console.error(
    'Error: migration name required.\n  Usage: pnpm db:migration:generate <Name>\n         pnpm db:control:migration:generate <Name>',
  );
  process.exit(1);
}

execFileSync(
  'typeorm-ts-node-commonjs',
  [
    'migration:generate',
    `${control ? 'migrations-control' : 'migrations'}/${name}`,
    '-d',
    control ? 'cli/control-data-source.ts' : 'cli/data-source.ts',
  ],
  { stdio: 'inherit' },
);
