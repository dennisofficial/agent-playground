import { describe, expect, it } from 'bun:test'

import { commandEffect, ECommandEffect } from '../command-effect'

const starts = (command: string): boolean =>
  commandEffect({ command }) === ECommandEffect.StartsWork

const changes = (command: string): boolean =>
  commandEffect({ command }) === ECommandEffect.ChangesPullRequest

const effectOf = (command: string): ECommandEffect => commandEffect({ command })

describe('commands that start work', () => {
  it('reads a push in the spellings anyone actually writes', () => {
    expect(starts('git push')).toBe(true)
    expect(starts('git push -u origin HEAD')).toBe(true)
    expect(starts('git push --force-with-lease')).toBe(true)
    expect(starts('git push origin main')).toBe(true)
    expect(starts('git push origin HEAD:refs/heads/feature')).toBe(true)
  })

  it('reads a push through a git that was told where to run', () => {
    expect(starts('git -C /work/atlas push')).toBe(true)
  })

  it('reads the gh commands that set work going', () => {
    expect(starts('gh pr create --fill')).toBe(true)
    expect(starts('gh pr create --draft --title "wip"')).toBe(true)
    expect(starts('gh pr ready')).toBe(true)
    expect(starts('gh workflow run ci.yml')).toBe(true)
    expect(starts('gh run rerun 123 --failed')).toBe(true)
  })

  it('survives the chains a model writes', () => {
    expect(starts('bun test && git push')).toBe(true)
    expect(starts('bun run typecheck && bun test && git push -u origin HEAD')).toBe(true)
    expect(starts('git add -A; git commit -m "wip"; git push')).toBe(true)
    expect(starts('git push || echo failed')).toBe(true)
    expect(starts('git log --oneline | head -5\ngit push')).toBe(true)
  })

  it('looks past whatever a command carries in front of it', () => {
    expect(starts('GIT_SSH_COMMAND="ssh -i k" git push')).toBe(true)
    expect(starts('FOO=1 BAR=2 gh pr create')).toBe(true)
    expect(starts('sudo -E git push')).toBe(true)
  })

  /** A dry run pushes nothing, so nothing downstream of it will start a check. */
  it('refuses a dry run', () => {
    expect(starts('git push --dry-run')).toBe(false)
    expect(starts('git push --dry-run origin main')).toBe(false)
  })

  it('refuses a command that merely contains the word', () => {
    expect(starts('git pushd')).toBe(false)
    expect(starts('echo "git push"')).toBe(false)
    expect(starts('cat notes-about-git-push.md')).toBe(false)
    expect(starts('grep -r push src')).toBe(false)
  })

  it('refuses the git and gh commands that start nothing', () => {
    expect(starts('git status')).toBe(false)
    expect(starts('git commit -m "done"')).toBe(false)
    expect(starts('git fetch origin')).toBe(false)
    expect(starts('git pull --ff-only')).toBe(false)
    expect(starts('gh pr view --json number,state')).toBe(false)
    expect(starts('gh pr list')).toBe(false)
    expect(starts('gh run list --limit 5')).toBe(false)
  })

  it('refuses an empty or whitespace command', () => {
    expect(starts('')).toBe(false)
    expect(starts('   ')).toBe(false)
    expect(starts('\n\n')).toBe(false)
  })

  /**
   * Pinned as a known cost rather than a defect: the rule is a word match rather than a parse, so a
   * commit whose unquoted message is the word buys one extra pull-request read and nothing else.
   */
  it('would rather over-read than parse a shell', () => {
    expect(starts('git commit -m push')).toBe(true)
  })
})

describe('commands that change a pull request without starting anything', () => {
  it('reads the gh commands that settle a pull request', () => {
    expect(changes('gh pr merge')).toBe(true)
    expect(changes('gh pr merge --squash --delete-branch')).toBe(true)
    expect(changes('gh pr close 412')).toBe(true)
    expect(changes('gh pr reopen')).toBe(true)
  })

  /**
   * These want one read, not a window: nothing is pending after a merge, so keeping the eager
   * cadence for three minutes would poll a settled pull request for no reason.
   */
  it('is not the same effect as starting work', () => {
    expect(effectOf('gh pr merge')).toBe(ECommandEffect.ChangesPullRequest)
    expect(effectOf('git push')).toBe(ECommandEffect.StartsWork)
  })

  it('leaves the reads that change nothing alone', () => {
    expect(effectOf('gh pr view --json state')).toBe(ECommandEffect.Nothing)
    expect(effectOf('gh pr list')).toBe(ECommandEffect.Nothing)
    expect(effectOf('gh pr diff')).toBe(ECommandEffect.Nothing)
  })

  it('survives a chain and the flags a merge carries', () => {
    expect(changes('bun test && gh pr merge --auto')).toBe(true)
    expect(changes('gh pr merge; echo merged')).toBe(true)
  })
})

describe('a chain that does both', () => {
  it('prefers the window, because a check that does not exist yet is what needs chasing', () => {
    expect(effectOf('git push && gh pr merge')).toBe(ECommandEffect.StartsWork)
    expect(effectOf('gh pr merge && git push')).toBe(ECommandEffect.StartsWork)
  })
})
