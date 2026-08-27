import { describe, expect, it } from 'bun:test'

import {
  EInstructionFamily,
  EInstructionOrigin,
  instructionCandidates,
} from '../instruction-files'

const pathsOf = (candidates: readonly { path: string }[]): string[] =>
  candidates.map((candidate) => candidate.path)

const project = (args: {
  root: string
  cwd: string
  family?: EInstructionFamily
}): readonly { path: string; origin: EInstructionOrigin }[] =>
  instructionCandidates({
    root: args.root,
    cwd: args.cwd,
    userDirectories: [],
    family: args.family ?? EInstructionFamily.Both,
    includeUser: false,
    includeProject: true,
  })

describe('instructionCandidates, project scope', () => {
  it('reads a single directory when the root is the working directory', () => {
    expect(pathsOf(project({ root: '/repo', cwd: '/repo' }))).toEqual([
      '/repo/AGENTS.md',
      '/repo/CLAUDE.md',
      '/repo/AGENTS.local.md',
      '/repo/CLAUDE.local.md',
    ])
  })

  it('walks root to cwd so that deeper directories land later', () => {
    const paths = pathsOf(project({ root: '/repo', cwd: '/repo/apps/tui' }))

    expect(paths.indexOf('/repo/CLAUDE.md')).toBeLessThan(paths.indexOf('/repo/apps/CLAUDE.md'))
    expect(paths.indexOf('/repo/apps/CLAUDE.md')).toBeLessThan(
      paths.indexOf('/repo/apps/tui/CLAUDE.md'),
    )
  })

  it('puts CLAUDE.md after AGENTS.md within one directory, and local files after both', () => {
    expect(pathsOf(project({ root: '/repo', cwd: '/repo' }))).toEqual([
      '/repo/AGENTS.md',
      '/repo/CLAUDE.md',
      '/repo/AGENTS.local.md',
      '/repo/CLAUDE.local.md',
    ])
  })

  it('narrows to one family when asked', () => {
    expect(pathsOf(project({ root: '/repo', cwd: '/repo', family: EInstructionFamily.Claude }))).toEqual([
      '/repo/CLAUDE.md',
      '/repo/CLAUDE.local.md',
    ])

    expect(pathsOf(project({ root: '/repo', cwd: '/repo', family: EInstructionFamily.Agents }))).toEqual([
      '/repo/AGENTS.md',
      '/repo/AGENTS.local.md',
    ])
  })

  it('marks a local file as a distinct origin so rendering can say it is not checked in', () => {
    const candidates = project({ root: '/repo', cwd: '/repo' })

    expect(candidates.find((candidate) => candidate.path === '/repo/CLAUDE.md')?.origin).toBe(
      EInstructionOrigin.Project,
    )
    expect(candidates.find((candidate) => candidate.path === '/repo/CLAUDE.local.md')?.origin).toBe(
      EInstructionOrigin.ProjectLocal,
    )
  })

  it('stays inside the root when the working directory escapes it', () => {
    expect(pathsOf(project({ root: '/repo', cwd: '/elsewhere/deep' }))).toEqual([
      '/repo/AGENTS.md',
      '/repo/CLAUDE.md',
      '/repo/AGENTS.local.md',
      '/repo/CLAUDE.local.md',
    ])
  })

  it('is not fooled by a sibling directory sharing the root as a string prefix', () => {
    expect(pathsOf(project({ root: '/repo', cwd: '/repo-other/pkg' }))).toEqual([
      '/repo/AGENTS.md',
      '/repo/CLAUDE.md',
      '/repo/AGENTS.local.md',
      '/repo/CLAUDE.local.md',
    ])
  })

  it('tolerates trailing separators on either path', () => {
    expect(pathsOf(project({ root: '/repo/', cwd: '/repo/apps/' }))).toEqual(
      pathsOf(project({ root: '/repo', cwd: '/repo/apps' })),
    )
  })

  it('walks from the filesystem root without doubling the separator', () => {
    expect(pathsOf(project({ root: '/', cwd: '/srv' }))).toEqual([
      '/AGENTS.md',
      '/CLAUDE.md',
      '/AGENTS.local.md',
      '/CLAUDE.local.md',
      '/srv/AGENTS.md',
      '/srv/CLAUDE.md',
      '/srv/AGENTS.local.md',
      '/srv/CLAUDE.local.md',
    ])
  })

  it('yields nothing when project scope is switched off', () => {
    expect(
      instructionCandidates({
        root: '/repo',
        cwd: '/repo',
        userDirectories: [],
        family: EInstructionFamily.Both,
        includeUser: false,
        includeProject: false,
      }),
    ).toEqual([])
  })
})

describe('instructionCandidates, user scope', () => {
  const withUser = (args: { includeProject: boolean }) =>
    instructionCandidates({
      root: '/repo',
      cwd: '/repo',
      userDirectories: ['/home/dev/.claude', '/home/dev/.atlas'],
      family: EInstructionFamily.Claude,
      includeUser: true,
      includeProject: args.includeProject,
    })

  it('places every user directory before the project, in the order given', () => {
    expect(pathsOf(withUser({ includeProject: true }))).toEqual([
      '/home/dev/.claude/CLAUDE.md',
      '/home/dev/.atlas/CLAUDE.md',
      '/repo/CLAUDE.md',
      '/repo/CLAUDE.local.md',
    ])
  })

  it('offers no local variant in user scope, where a global file is already private', () => {
    expect(pathsOf(withUser({ includeProject: false }))).toEqual([
      '/home/dev/.claude/CLAUDE.md',
      '/home/dev/.atlas/CLAUDE.md',
    ])
  })

  it('marks user files with their own origin', () => {
    const first = withUser({ includeProject: false })[0]

    expect(first?.origin).toBe(EInstructionOrigin.UserGlobal)
  })

  it('yields nothing for user scope when it is switched off', () => {
    expect(
      pathsOf(
        instructionCandidates({
          root: '/repo',
          cwd: '/repo',
          userDirectories: ['/home/dev/.claude'],
          family: EInstructionFamily.Claude,
          includeUser: false,
          includeProject: false,
        }),
      ),
    ).toEqual([])
  })

  it('never offers the same path twice when a user directory sits inside the walk', () => {
    const paths = pathsOf(
      instructionCandidates({
        root: '/repo',
        cwd: '/repo',
        userDirectories: ['/repo'],
        family: EInstructionFamily.Claude,
        includeUser: true,
        includeProject: true,
      }),
    )

    expect(paths).toEqual([...new Set(paths)])
  })
})
