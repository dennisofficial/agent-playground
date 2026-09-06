import {
  chmod as nodeChmod,
  mkdir as nodeMkdir,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  readlink as nodeReadlink,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises'

import { FileSystemPort, type FileStat, type FileSystemEntry } from '@dltech/atlas-core'

export class LocalFileSystemPort implements FileSystemPort {
  stat(args: { path: string }): Promise<FileStat> {
    return nodeStat(args.path)
  }

  async readLink(args: { path: string }): Promise<string | null> {
    return await nodeReadlink(args.path).catch(() => null)
  }

  readFile(args: { path: string }): Promise<string> {
    return nodeReadFile(args.path, 'utf8')
  }

  async readBytes(args: { path: string }): Promise<Uint8Array> {
    return await nodeReadFile(args.path)
  }

  async writeFile(args: { path: string; content: string; mode?: number }): Promise<void> {
    await nodeWriteFile(args.path, args.content, 'utf8')
    // node applies the mode at creation under the umask; chmod after is the only exact write.
    if (args.mode !== undefined) await nodeChmod(args.path, args.mode)
  }

  async removeFile(args: { path: string }): Promise<void> {
    await nodeUnlink(args.path)
  }

  async mkdir(args: { path: string }): Promise<void> {
    await nodeMkdir(args.path, { recursive: true })
  }

  async rename(args: { from: string; to: string }): Promise<void> {
    await nodeRename(args.from, args.to)
  }

  readDirectory(args: { path: string }): Promise<readonly FileSystemEntry[]> {
    return nodeReaddir(args.path, { withFileTypes: true })
  }

  async glob(args: { pattern: string; cwd: string }): Promise<readonly string[]> {
    const found: string[] = []
    const scan = new Bun.Glob(args.pattern).scan({ cwd: args.cwd, absolute: true, onlyFiles: true })
    for await (const match of scan) found.push(match)
    return found
  }
}
