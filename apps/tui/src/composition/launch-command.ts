import { basename } from 'node:path'

const DEV_COMMAND = 'atlas-dev'

/**
 * `bun build --compile` mounts the bundle on a virtual filesystem and hands the entry point to the
 * process as a path inside it, so the entry is what tells a shipped binary apart from a source
 * launch. The prefix is Bun's, not ours.
 * https://bun.com/docs/bundler/executables
 */
const COMPILED_ROOT = '/$bunfs/'

export function launchCommand(args: { execPath: string; entry: string | undefined }): string {
  if (args.entry === undefined || !args.entry.startsWith(COMPILED_ROOT)) return DEV_COMMAND

  return basename(args.execPath)
}
