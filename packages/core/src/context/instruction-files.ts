export enum EInstructionFamily {
  Claude = 'claude',
  Agents = 'agents',
  Both = 'both',
}

export enum EInstructionOrigin {
  UserGlobal = 'user-global',
  Project = 'project',
  ProjectLocal = 'project-local',
}

export type InstructionCandidate = {
  path: string
  origin: EInstructionOrigin
}

const SEPARATOR = '/'

const AGENTS_FILE = 'AGENTS.md'
const CLAUDE_FILE = 'CLAUDE.md'
const AGENTS_LOCAL_FILE = 'AGENTS.local.md'
const CLAUDE_LOCAL_FILE = 'CLAUDE.local.md'

const withoutTrailingSeparator = (path: string): string =>
  path.length > 1 && path.endsWith(SEPARATOR) ? path.slice(0, -1) : path

const joined = ({ directory, name }: { directory: string; name: string }): string =>
  directory === SEPARATOR ? `${SEPARATOR}${name}` : `${directory}${SEPARATOR}${name}`

function sharedFilesOf(family: EInstructionFamily): readonly string[] {
  if (family === EInstructionFamily.Claude) return [CLAUDE_FILE]
  if (family === EInstructionFamily.Agents) return [AGENTS_FILE]
  return [AGENTS_FILE, CLAUDE_FILE]
}

function localFilesOf(family: EInstructionFamily): readonly string[] {
  if (family === EInstructionFamily.Claude) return [CLAUDE_LOCAL_FILE]
  if (family === EInstructionFamily.Agents) return [AGENTS_LOCAL_FILE]
  return [AGENTS_LOCAL_FILE, CLAUDE_LOCAL_FILE]
}

function descentFrom({ root, cwd }: { root: string; cwd: string }): readonly string[] {
  const base = withoutTrailingSeparator(root)
  const target = withoutTrailingSeparator(cwd)
  if (target === base) return [base]

  const prefix = base === SEPARATOR ? SEPARATOR : `${base}${SEPARATOR}`
  if (!target.startsWith(prefix)) return [base]

  const directories = [base]
  let current = base === SEPARATOR ? '' : base

  for (const segment of target.slice(prefix.length).split(SEPARATOR)) {
    if (segment === '') continue
    current = `${current}${SEPARATOR}${segment}`
    directories.push(current)
  }

  return directories
}

function userCandidates(args: {
  userDirectories: readonly string[]
  family: EInstructionFamily
}): readonly InstructionCandidate[] {
  return args.userDirectories.flatMap((directory) =>
    sharedFilesOf(args.family).map((name) => ({
      path: joined({ directory: withoutTrailingSeparator(directory), name }),
      origin: EInstructionOrigin.UserGlobal,
    })),
  )
}

function projectCandidates(args: {
  root: string
  cwd: string
  family: EInstructionFamily
}): readonly InstructionCandidate[] {
  const shared = sharedFilesOf(args.family)
  const local = localFilesOf(args.family)

  return descentFrom({ root: args.root, cwd: args.cwd }).flatMap((directory) => [
    ...shared.map((name) => ({
      path: joined({ directory, name }),
      origin: EInstructionOrigin.Project,
    })),
    ...local.map((name) => ({
      path: joined({ directory, name }),
      origin: EInstructionOrigin.ProjectLocal,
    })),
  ])
}

export function instructionCandidates(args: {
  root: string
  cwd: string
  userDirectories: readonly string[]
  family: EInstructionFamily
  includeUser: boolean
  includeProject: boolean
}): readonly InstructionCandidate[] {
  const ordered = [
    ...(args.includeUser ? userCandidates({ userDirectories: args.userDirectories, family: args.family }) : []),
    ...(args.includeProject
      ? projectCandidates({ root: args.root, cwd: args.cwd, family: args.family })
      : []),
  ]

  const seen = new Set<string>()
  return ordered.filter((candidate) => {
    if (seen.has(candidate.path)) return false
    seen.add(candidate.path)
    return true
  })
}
