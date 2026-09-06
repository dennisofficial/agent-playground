import { describe, expect, it } from 'bun:test'

import { outsideProjectNotice } from '../outside-project'

const PROJECT = '/Users/dennis/Developer/atlas/.atlas/worktrees/highlight-loop'

describe('outsideProjectNotice', () => {
  it('stays silent for a write inside the project directory', () => {
    expect(
      outsideProjectNotice({ path: `${PROJECT}/apps/tui/src/main.tsx`, projectDirectory: PROJECT }),
    ).toBeUndefined()
  })

  it('stays silent for the project directory itself', () => {
    expect(outsideProjectNotice({ path: PROJECT, projectDirectory: PROJECT })).toBeUndefined()
  })

  it('resolves a relative path against the project directory', () => {
    expect(
      outsideProjectNotice({ path: 'apps/tui/src/main.tsx', projectDirectory: PROJECT }),
    ).toBeUndefined()
  })

  it('nudges on a write into a sibling worktree, naming both directories', () => {
    const target =
      '/Users/dennis/Developer/atlas/.atlas/worktrees/cheap-shimmer/apps/tui/src/ui/shimmer.ts'

    const notice = outsideProjectNotice({ path: target, projectDirectory: PROJECT })

    expect(notice).toContain(target)
    expect(notice).toContain(PROJECT)
    expect(notice).toContain('enter_worktree')
  })

  it('nudges on a write into another repository under home', () => {
    expect(
      outsideProjectNotice({
        path: '/Users/dennis/Developer/comp-v3/apps/web/src/page.tsx',
        projectDirectory: PROJECT,
      }),
    ).toBeDefined()
  })

  it('nudges on a dotfile deep inside another project', () => {
    expect(
      outsideProjectNotice({
        path: '/Users/dennis/Developer/comp-v3/.env',
        projectDirectory: PROJECT,
      }),
    ).toBeDefined()
  })

  it('stays silent for atlas home', () => {
    expect(
      outsideProjectNotice({
        path: '/Users/dennis/.atlas/projects/-Users-dennis/memory/note.md',
        projectDirectory: PROJECT,
      }),
    ).toBeUndefined()
  })

  it('stays silent for dotfiles and dot-directories straight under home', () => {
    for (const path of [
      '/Users/dennis/.zshrc',
      '/Users/dennis/.config/ghostty/config',
      '/home/dennis/.claude/skills/x/SKILL.md',
      '~/.agents/skills/x/SKILL.md',
    ]) {
      expect(outsideProjectNotice({ path, projectDirectory: PROJECT })).toBeUndefined()
    }
  })

  it('stays silent for temporary roots', () => {
    for (const path of [
      '/tmp/scratch.ts',
      '/private/tmp/scratch.ts',
      '/var/tmp/scratch.ts',
      '/var/folders/9x/abcd/T/build-output.log',
    ]) {
      expect(outsideProjectNotice({ path, projectDirectory: PROJECT })).toBeUndefined()
    }
  })

  it('normalises .. segments before judging', () => {
    expect(
      outsideProjectNotice({
        path: `${PROJECT}/apps/../../comp-v3/src/index.ts`,
        projectDirectory: PROJECT,
      }),
    ).toBeDefined()
  })
})
