import type { Event } from '../events/envelope'

export type WorkspaceDirectories = {
  projectDirectory: string
  sessionDirectory: string
}

export function sessionDirectoryOf(args: {
  events: readonly Event[]
  projectDirectory: string
}): string {
  for (let index = args.events.length - 1; index >= 0; index -= 1) {
    const event = args.events[index]
    if (event?.type === 'cwd-changed') return event.path
  }

  return args.projectDirectory
}

export function workspaceDirectoriesOf(args: {
  events: readonly Event[]
  projectDirectory: string
}): WorkspaceDirectories {
  return {
    projectDirectory: args.projectDirectory,
    sessionDirectory: sessionDirectoryOf(args),
  }
}

export const hasMovedFromProject = (directories: WorkspaceDirectories): boolean =>
  directories.sessionDirectory !== directories.projectDirectory

