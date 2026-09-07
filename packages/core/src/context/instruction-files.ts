export enum EInstructionFamily {
  Claude = 'claude',
  Agents = 'agents',
  Both = 'both',
  None = 'none',
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

type InstructionNames = {
  shared: string
  local: string
}

const ATLAS_NAMES: InstructionNames = { shared: 'ATLAS.md', local: 'ATLAS.local.md' }
const AGENTS_NAMES: InstructionNames = { shared: 'AGENTS.md', local: 'AGENTS.local.md' }
const CLAUDE_NAMES: InstructionNames = { shared: 'CLAUDE.md', local: 'CLAUDE.local.md' }

const withoutTrailingSeparator = (path: string): string =>
  path.length > 1 && path.endsWith(SEPARATOR) ? path.slice(0, -1) : path

const joined = ({ directory, name }: { directory: string; name: string }): string =>
  directory === SEPARATOR ? `${SEPARATOR}${name}` : `${directory}${SEPARATOR}${name}`

function borrowedNamesOf(family: EInstructionFamily): readonly InstructionNames[] {
  if (family === EInstructionFamily.None) return []
  if (family === EInstructionFamily.Claude) return [CLAUDE_NAMES]
  if (family === EInstructionFamily.Agents) return [AGENTS_NAMES]
  return [AGENTS_NAMES, CLAUDE_NAMES]
}

const projectNamesOf = (family: EInstructionFamily): readonly InstructionNames[] => [
  ...borrowedNamesOf(family),
  ATLAS_NAMES,
]

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
}): readonly InstructionCandidate[] {
  return args.userDirectories.map((directory) => ({
    path: joined({ directory: withoutTrailingSeparator(directory), name: ATLAS_NAMES.shared }),
    origin: EInstructionOrigin.UserGlobal,
  }))
}

function projectCandidates(args: {
  root: string
  cwd: string
  family: EInstructionFamily
}): readonly InstructionCandidate[] {
  const names = projectNamesOf(args.family)

  return descentFrom({ root: args.root, cwd: args.cwd }).flatMap((directory) => [
    ...names.map(({ shared }) => ({
      path: joined({ directory, name: shared }),
      origin: EInstructionOrigin.Project,
    })),
    ...names.map(({ local }) => ({
      path: joined({ directory, name: local }),
      origin: EInstructionOrigin.ProjectLocal,
    })),
  ])
}

export function nestedInstructionCandidates(args: {
  root: string
  cwd: string
  touchedDirectory: string
  family: EInstructionFamily
}): readonly InstructionCandidate[] {
  const covered = new Set(
    projectCandidates({ root: args.root, cwd: args.cwd, family: args.family }).map(
      (candidate) => candidate.path,
    ),
  )

  return projectCandidates({
    root: args.root,
    cwd: args.touchedDirectory,
    family: args.family,
  }).filter((candidate) => !covered.has(candidate.path))
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
    ...(args.includeUser ? userCandidates({ userDirectories: args.userDirectories }) : []),
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
