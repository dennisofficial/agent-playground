import { existsSync } from 'node:fs'
import { join } from 'node:path'

const packageRoot = join(import.meta.dir, '..')

if (existsSync(join(import.meta.dir, 'generated', 'client.ts'))) process.exit(0)

const generate = Bun.spawnSync(['bun', 'x', 'prisma', 'generate'], {
  cwd: packageRoot,
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(generate.exitCode ?? 1)
