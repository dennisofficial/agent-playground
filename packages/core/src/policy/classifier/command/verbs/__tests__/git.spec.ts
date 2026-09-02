import { describe, expect, it } from 'bun:test'

import { EDeed, EDeedRealm } from '../../../deed'
import { actionsFor, oneDeed, PROJECT, targetValues } from './read-deeds'

const actionOf = (command: string): EDeed => oneDeed({ command }).action

describe('the read side of git', () => {
  it('keeps status, log, diff, show and fetch read-only', () => {
    for (const command of [
      'git status',
      'git log --oneline',
      'git diff HEAD',
      'git show abc',
      'git fetch origin',
    ]) {
      expect(actionOf(command)).toBe(EDeed.ReadOnly)
    }
  })

  it('reads a dry-run clean and cleans untracked files otherwise', () => {
    expect(actionOf('git clean -ndx')).toBe(EDeed.ReadOnly)
    expect(actionOf('git clean -fdx')).toBe(EDeed.CleanUntracked)
  })

  it('reads a stash listing and mutates the stack on drop', () => {
    expect(actionOf('git stash list')).toBe(EDeed.ReadOnly)
    expect(actionOf('git stash show')).toBe(EDeed.ReadOnly)
    expect(actionOf('git stash drop')).toBe(EDeed.MutateStash)
    expect(actionOf('git stash clear')).toBe(EDeed.MutateStash)
    expect(actionOf('git stash pop')).toBe(EDeed.MutateStash)
  })

  it('reads pushing onto the stash as saving work, not as losing it', () => {
    expect(actionOf('git stash')).toBe(EDeed.WriteFile)
    expect(actionOf('git stash push')).toBe(EDeed.WriteFile)
    expect(actionOf('git stash push -m wip')).toBe(EDeed.WriteFile)
    expect(actionOf('git stash save wip')).toBe(EDeed.WriteFile)
  })

  it('reads a fast-forward pull as a fast-forward, and any other pull as a merge', () => {
    expect(actionOf('git pull --ff-only')).toBe(EDeed.FastForward)
    expect(actionOf('git pull')).toBe(EDeed.WriteFile)
  })

  it('separates the worktree verbs the operator uses every day', () => {
    expect(actionOf('git worktree list')).toBe(EDeed.ReadOnly)
    expect(actionOf('git worktree prune')).toBe(EDeed.ReadOnly)
    expect(actionOf('git worktree add .atlas/worktrees/x -b b origin/main')).toBe(EDeed.AddWorktree)
    expect(actionOf('git worktree remove .atlas/worktrees/x')).toBe(EDeed.RemoveWorktree)
  })

  it('names the worktree it would remove, resolved against the cwd', () => {
    const deed = oneDeed({ command: 'git worktree remove .atlas/worktrees/x' })

    expect(deed.targets).toEqual([
      { realm: EDeedRealm.GitWorktree, value: `${PROJECT}/.atlas/worktrees/x` },
    ])
  })

  it('names the worktree an add would create, not the branch or the base it names', () => {
    const deed = oneDeed({ command: 'git worktree add .atlas/worktrees/x -b b origin/main' })

    expect(deed.targets).toEqual([
      { realm: EDeedRealm.GitWorktree, value: `${PROJECT}/.atlas/worktrees/x` },
    ])
  })
})

describe('the destructive side of git', () => {
  it('reads a hard reset as discarding the whole working tree, keeping the ref literal', () => {
    const deed = oneDeed({ command: 'git reset --hard origin/main' })

    expect(deed.action).toBe(EDeed.DiscardWorkingTree)
    expect(deed.targets).toEqual([
      { realm: EDeedRealm.GitWorktree, value: PROJECT },
      { realm: EDeedRealm.GitRef, value: 'origin/main' },
    ])
  })

  it('scopes a pathspec checkout to the pathspec and a bare one to the whole tree', () => {
    const scoped = oneDeed({ command: 'git checkout -- packages/core/src/foo.ts' })
    expect(scoped.action).toBe(EDeed.DiscardWorkingTree)
    expect(scoped.targets).toEqual([
      { realm: EDeedRealm.Path, value: `${PROJECT}/packages/core/src/foo.ts` },
    ])

    const wide = oneDeed({ command: 'git checkout -- .' })
    expect(wide.action).toBe(EDeed.DiscardWorkingTree)
    expect(wide.targets).toEqual([{ realm: EDeedRealm.GitWorktree, value: PROJECT }])
  })

  it('treats a branch switch as a write, not as discarding anything', () => {
    expect(actionOf('git checkout main')).toBe(EDeed.WriteFile)
    expect(actionOf('git switch main')).toBe(EDeed.WriteFile)
  })

  it('deletes branches through branch -D and push --delete', () => {
    expect(actionOf('git branch -D dennis/eng-327')).toBe(EDeed.DeleteBranch)
    expect(actionOf('git branch -d dennis/eng-327')).toBe(EDeed.DeleteBranch)
    expect(actionOf('git push origin --delete dennis/eng-327')).toBe(EDeed.DeleteBranch)
    expect(actionOf('git branch')).toBe(EDeed.ReadOnly)
  })

  it('force-pushes on the flags and on a plus-prefixed refspec', () => {
    expect(actionOf('git push --force origin main')).toBe(EDeed.ForcePush)
    expect(actionOf('git push -f')).toBe(EDeed.ForcePush)
    expect(actionOf('git push --force-with-lease origin main')).toBe(EDeed.ForcePush)
    expect(actionOf('git push origin +main')).toBe(EDeed.ForcePush)
  })

  it('leaves an ordinary push routine so the common case never escalates', () => {
    expect(actionOf('git push origin main')).toBe(EDeed.Routine)
    expect(actionOf('git push --dry-run')).toBe(EDeed.ReadOnly)
  })

  it('rewrites history on rebase, amend and filter-branch', () => {
    expect(actionOf('git rebase origin/main')).toBe(EDeed.RewriteHistory)
    expect(actionOf('git commit --amend --no-edit')).toBe(EDeed.RewriteHistory)
    expect(actionOf('git filter-branch --tree-filter x')).toBe(EDeed.RewriteHistory)
  })

  it('separates dropping the recovery path from rewriting history', () => {
    expect(actionOf('git reflog expire --expire=now --all')).toBe(EDeed.DropRecovery)
    expect(actionOf('git gc --prune=now')).toBe(EDeed.DropRecovery)
  })

  it('keeps the harmless neighbours of those verbs quiet', () => {
    expect(actionOf('git rebase --abort')).toBe(EDeed.WriteFile)
    expect(actionOf('git reflog')).toBe(EDeed.ReadOnly)
    expect(actionOf('git gc')).toBe(EDeed.Routine)
    expect(actionOf('git commit -m "x"')).toBe(EDeed.WriteFile)
    expect(actionOf('git add -A')).toBe(EDeed.Routine)
  })

  it('follows git -C into the directory the deed lands in', () => {
    const deed = oneDeed({ command: 'git -C ../sibling reset --hard' })

    expect(deed.action).toBe(EDeed.DiscardWorkingTree)
    expect(deed.cwd).toBe('/sibling')
    expect(targetValues({ deed })).toEqual(['/sibling'])
  })

  it('gives an unknown git verb no guess at all', () => {
    expect(actionOf('git lfs push')).toBe(EDeed.Unreadable)
  })

  it('reads a fetch and a worktree add as two deeds, in order', () => {
    expect(
      actionsFor({
        command: 'git fetch origin && git worktree add .atlas/worktrees/x -b b origin/main',
      }),
    ).toEqual([EDeed.ReadOnly, EDeed.AddWorktree])
  })
})
