import { statSync } from 'node:fs'

export enum EDirectory {
  Present = 'present',
  Missing = 'missing',
  NotADirectory = 'not-a-directory',
}

export function stateOfDirectory(directory: string): EDirectory {
  try {
    return statSync(directory).isDirectory() ? EDirectory.Present : EDirectory.NotADirectory
  } catch {
    return EDirectory.Missing
  }
}

export function workspaceRefusal(args: { directory: string; state: EDirectory }): string | null {
  if (args.state === EDirectory.Present) return null

  const fault = args.state === EDirectory.Missing ? 'no such directory' : 'not a directory'
  return `Atlas cannot work in ${args.directory}: ${fault}.`
}
