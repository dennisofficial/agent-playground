import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const packageRoot = join(import.meta.dir, '..')
const schema = join(import.meta.dir, 'schema.prisma')
const client = join(import.meta.dir, 'generated', 'client.ts')

const modifiedAt = (path: string): number => (existsSync(path) ? statSync(path).mtimeMs : 0)

if (modifiedAt(client) > modifiedAt(schema)) process.exit(0)

const generate = Bun.spawnSync(['bun', 'x', 'prisma', 'generate'], {
  cwd: packageRoot,
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(generate.exitCode ?? 1)
