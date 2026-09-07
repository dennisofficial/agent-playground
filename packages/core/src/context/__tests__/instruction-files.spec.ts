import { describe, expect, it } from 'bun:test'

import {
  EInstructionFamily,
  EInstructionOrigin,
  instructionCandidates,
  nestedInstructionCandidates,
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

const namesIn = (directory: string): string[] => [
  `${directory}/AGENTS.md`,
  `${directory}/CLAUDE.md`,
  `${directory}/ATLAS.md`,
  `${directory}/AGENTS.local.md`,
  `${directory}/CLAUDE.local.md`,
  `${directory}/ATLAS.local.md`,
]

describe('instructionCandidates, project scope', () => {
  it('reads a single directory when the root is the working directory', () => {
    expect(pathsOf(project({ root: '/repo', cwd: '/repo' }))).toEqual(namesIn('/repo'))
  })

  it('walks root to cwd so that deeper directories land later', () => {
    const paths = pathsOf(project({ root: '/repo', cwd: '/repo/apps/tui' }))

    expect(paths.indexOf('/repo/ATLAS.md')).toBeLessThan(paths.indexOf('/repo/apps/ATLAS.md'))
    expect(paths.indexOf('/repo/apps/ATLAS.md')).toBeLessThan(
      paths.indexOf('/repo/apps/tui/ATLAS.md'),
    )
  })

  it('loads ATLAS.md after the borrowed files, and every local file after all of them', () => {
    expect(pathsOf(project({ root: '/repo', cwd: '/repo' }))).toEqual([
      '/repo/AGENTS.md',
      '/repo/CLAUDE.md',
      '/repo/ATLAS.md',
      '/repo/AGENTS.local.md',
      '/repo/CLAUDE.local.md',
      '/repo/ATLAS.local.md',
    ])
  })

  it('narrows to one borrowed family when asked, keeping ATLAS.md', () => {
    expect(
      pathsOf(project({ root: '/repo', cwd: '/repo', family: EInstructionFamily.Claude })),
    ).toEqual([
      '/repo/CLAUDE.md',
      '/repo/ATLAS.md',
      '/repo/CLAUDE.local.md',
      '/repo/ATLAS.local.md',
    ])

    expect(
      pathsOf(project({ root: '/repo', cwd: '/repo', family: EInstructionFamily.Agents })),
    ).toEqual([
      '/repo/AGENTS.md',
      '/repo/ATLAS.md',
      '/repo/AGENTS.local.md',
      '/repo/ATLAS.local.md',
    ])
  })

  it('reads only ATLAS.md when no borrowed family is wanted', () => {
    expect(
      pathsOf(project({ root: '/repo', cwd: '/repo', family: EInstructionFamily.None })),
    ).toEqual(['/repo/ATLAS.md', '/repo/ATLAS.local.md'])
  })

  it('marks a local file as a distinct origin so rendering can say it is not checked in', () => {
    const candidates = project({ root: '/repo', cwd: '/repo' })

    expect(candidates.find((candidate) => candidate.path === '/repo/ATLAS.md')?.origin).toBe(
      EInstructionOrigin.Project,
    )
    expect(candidates.find((candidate) => candidate.path === '/repo/ATLAS.local.md')?.origin).toBe(
      EInstructionOrigin.ProjectLocal,
    )
  })

  it('stays inside the root when the working directory escapes it', () => {
    expect(pathsOf(project({ root: '/repo', cwd: '/elsewhere/deep' }))).toEqual(namesIn('/repo'))
  })

  it('is not fooled by a sibling directory sharing the root as a string prefix', () => {
    expect(pathsOf(project({ root: '/repo', cwd: '/repo-other/pkg' }))).toEqual(namesIn('/repo'))
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
      '/ATLAS.md',
      '/AGENTS.local.md',
      '/CLAUDE.local.md',
      '/ATLAS.local.md',
      ...namesIn('/srv'),
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

describe('nestedInstructionCandidates', () => {
  const nested = (args: {
    cwd: string
    touchedDirectory: string
    family?: EInstructionFamily
  }): readonly { path: string; origin: EInstructionOrigin }[] =>
    nestedInstructionCandidates({
      root: '/repo',
      cwd: args.cwd,
      touchedDirectory: args.touchedDirectory,
      family: args.family ?? EInstructionFamily.Both,
    })

  it('offers the directories above a touched file that the project descent never visited', () => {
    expect(
      pathsOf(nested({ cwd: '/repo/apps/tui', touchedDirectory: '/repo/packages/core/src' })),
    ).toEqual([
      ...namesIn('/repo/packages'),
      ...namesIn('/repo/packages/core'),
      ...namesIn('/repo/packages/core/src'),
    ])
  })

  it('repeats nothing the project descent already covered', () => {
    expect(nested({ cwd: '/repo/apps/tui', touchedDirectory: '/repo/apps' })).toEqual([])
    expect(nested({ cwd: '/repo/apps/tui', touchedDirectory: '/repo/apps/tui' })).toEqual([])
    expect(nested({ cwd: '/repo/apps/tui', touchedDirectory: '/repo' })).toEqual([])
  })

  it('reaches directories deeper than the working directory', () => {
    expect(pathsOf(nested({ cwd: '/repo', touchedDirectory: '/repo/src/nested' }))).toEqual([
      ...namesIn('/repo/src'),
      ...namesIn('/repo/src/nested'),
    ])
  })

  it('stays inside the root when the touched path escapes it', () => {
    expect(nested({ cwd: '/repo', touchedDirectory: '/etc' })).toEqual([])
    expect(nested({ cwd: '/repo/apps', touchedDirectory: '/repo-other/pkg' })).toEqual([])
  })

  it('narrows to the borrowed family the project is read for', () => {
    expect(
      pathsOf(
        nested({ cwd: '/repo', touchedDirectory: '/repo/pkg', family: EInstructionFamily.Agents }),
      ),
    ).toEqual([
      '/repo/pkg/AGENTS.md',
      '/repo/pkg/ATLAS.md',
      '/repo/pkg/AGENTS.local.md',
      '/repo/pkg/ATLAS.local.md',
    ])
  })

  it('keeps the local origin so a private sibling still reads as one', () => {
    const candidates = nested({ cwd: '/repo', touchedDirectory: '/repo/pkg' })

    expect(
      candidates.find((candidate) => candidate.path === '/repo/pkg/ATLAS.local.md')?.origin,
    ).toBe(EInstructionOrigin.ProjectLocal)
  })
})

describe('instructionCandidates, user scope', () => {
  const withUser = (args: { includeProject: boolean }) =>
    instructionCandidates({
      root: '/repo',
      cwd: '/repo',
      userDirectories: ['/home/dev/.atlas', '/home/dev/.atlas-home'],
      family: EInstructionFamily.Claude,
      includeUser: true,
      includeProject: args.includeProject,
    })

  it('places every user directory before the project, in the order given', () => {
    expect(pathsOf(withUser({ includeProject: true }))).toEqual([
      '/home/dev/.atlas/ATLAS.md',
      '/home/dev/.atlas-home/ATLAS.md',
      '/repo/CLAUDE.md',
      '/repo/ATLAS.md',
      '/repo/CLAUDE.local.md',
      '/repo/ATLAS.local.md',
    ])
  })

  it('reads only ATLAS.md globally, whatever borrowed family the project is read for', () => {
    expect(pathsOf(withUser({ includeProject: false }))).toEqual([
      '/home/dev/.atlas/ATLAS.md',
      '/home/dev/.atlas-home/ATLAS.md',
    ])

    expect(
      pathsOf(
        instructionCandidates({
          root: '/repo',
          cwd: '/repo',
          userDirectories: ['/home/dev/.atlas'],
          family: EInstructionFamily.Both,
          includeUser: true,
          includeProject: false,
        }),
      ),
    ).toEqual(['/home/dev/.atlas/ATLAS.md'])
  })

  it('offers no local variant in user scope, where a global file is already private', () => {
    expect(
      pathsOf(withUser({ includeProject: false })).some((path) => path.includes('.local.md')),
    ).toBe(false)
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
          userDirectories: ['/home/dev/.atlas'],
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
    expect(paths.filter((path) => path === '/repo/ATLAS.md')).toHaveLength(1)
  })
})
