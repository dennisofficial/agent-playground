export type FileStat = {
  readonly size: number
  readonly mode: number
  readonly mtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
}

export type FileSystemEntry = {
  readonly name: string
  isFile(): boolean
  isDirectory(): boolean
}

export abstract class FileSystemPort {
  abstract stat(args: { path: string }): Promise<FileStat>

  /** Leaf symlink target (relative links unresolved), or null when the path is not a symlink. */
  abstract readLink(args: { path: string }): Promise<string | null>

  abstract readFile(args: { path: string }): Promise<string>

  abstract readBytes(args: { path: string }): Promise<Uint8Array>

  abstract writeFile(args: { path: string; content: string; mode?: number }): Promise<void>

  abstract removeFile(args: { path: string }): Promise<void>

  abstract mkdir(args: { path: string }): Promise<void>

  abstract rename(args: { from: string; to: string }): Promise<void>

  abstract readDirectory(args: { path: string }): Promise<readonly FileSystemEntry[]>

  abstract glob(args: { pattern: string; cwd: string; dot?: boolean }): Promise<readonly string[]>
}
