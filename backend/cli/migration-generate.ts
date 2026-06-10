import { execFileSync } from 'child_process';

const name = process.argv[2];
if (!name) {
  console.error('Error: migration name required.\n  Usage: pnpm db:migration:generate <Name>');
  process.exit(1);
}

execFileSync(
  'typeorm-ts-node-commonjs',
  ['migration:generate', `migrations/${name}`, '-d', 'cli/data-source.ts'],
  { stdio: 'inherit' },
);
