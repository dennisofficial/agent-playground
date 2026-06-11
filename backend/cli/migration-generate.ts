import { execFileSync } from 'child_process';

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
