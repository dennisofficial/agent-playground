import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const DEFAULT_FILE_MODE = 0o644

const PERMISSION_BITS = 0o777

const temporaryBeside = (path: string): string =>
  join(dirname(path), `.${basename(path)}.${randomUUID()}.atlas-partial`)

export async function writeFileAtomically(args: {
  path: string
  content: string
  mode?: number | undefined
}): Promise<number> {
  await mkdir(dirname(args.path), { recursive: true })

  const temporary = temporaryBeside(args.path)
  const mode = args.mode === undefined ? DEFAULT_FILE_MODE : args.mode & PERMISSION_BITS

  try {
    const handle = await open(temporary, 'wx', mode)
    try {
      await handle.writeFile(args.content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    await chmod(temporary, mode)
    await rename(temporary, args.path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }

  return Buffer.byteLength(args.content, 'utf8')
}
