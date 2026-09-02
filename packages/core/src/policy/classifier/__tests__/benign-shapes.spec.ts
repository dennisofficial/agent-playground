import { describe, expect, it } from 'bun:test'

import { EToolEffect } from '../../../tools/tool'
import { checkCorpusCase } from '../corpus'
import { ETriage } from '../triage'
import { CORPUS_DIRECTORY, readCorpus } from './corpus'
import {
  HOME,
  OURS,
  REPO,
  SIBLING,
  bashEvidence,
  inAWorktree,
  onMain,
  triageFor,
  writeEvidence,
} from './fixtures'

const clearsOnMain = (command: string, workdir?: string) =>
  triageFor({ evidence: bashEvidence({ command, workdir, facts: onMain() }) }).triage

const clearsInAWorktree = (command: string) =>
  triageFor({ evidence: bashEvidence({ command, facts: inAWorktree() }) }).triage

describe('the cleanup the operator is instructed to run', () => {
  it('clears git branch -D after a squash merge, because no remote carries the ref', () => {
    const facts = onMain()
    const evidence = bashEvidence({
      command: 'git branch -D dennis/eng-327-api-eslint',
      facts: {
        ...facts,
        refs: [{ ref: 'dennis/eng-327-api-eslint', onRemote: false, checkedOutAt: [] }],
      },
    })

    expect(triageFor({ evidence }).triage).toBe(ETriage.Clear)
  })

  it('clears an unforced worktree removal followed by a prune', () => {
    expect(clearsOnMain(`git worktree remove ${SIBLING} && git worktree prune`)).toBe(ETriage.Clear)
  })
})

describe('the recursive deletes that only remove what a build regenerates', () => {
  it('clears rm -rf over node_modules, dist, .turbo, .next and build', () => {
    expect(clearsOnMain('rm -rf node_modules dist .turbo .next build')).toBe(ETriage.Clear)
  })

  it('clears rm -rf node_modules inside a package of the workspace', () => {
    expect(clearsOnMain('rm -rf apps/tui/node_modules')).toBe(ETriage.Clear)
  })
})

describe('the git the operator runs on main every day', () => {
  it('clears a commit on main, because main is this session own project directory', () => {
    expect(clearsOnMain('git commit -m "feat(core): a thing"')).toBe(ETriage.Clear)
  })

  it('clears git worktree add run from the repo root', () => {
    expect(
      clearsOnMain('git worktree add .claude/worktrees/eng-500-x -b eng-500-x origin/main'),
    ).toBe(ETriage.Clear)
  })

  it('clears a rebase onto origin/main while the branch is on no remote', () => {
    const facts = inAWorktree({
      refs: [{ ref: 'dennis/eng-327-api-eslint', onRemote: false, checkedOutAt: [OURS] }],
    })

    expect(
      triageFor({ evidence: bashEvidence({ command: 'git rebase origin/main', facts }) }).triage,
    ).toBe(ETriage.Clear)
    expect(
      triageFor({ evidence: bashEvidence({ command: 'git push --force-with-lease', facts }) })
        .triage,
    ).toBe(ETriage.Clear)
  })
})

describe('the main checkout, which always carries the operator own uncommitted work', () => {
  it('clears a fast-forward pull, which the operator own instructions permit on main', () => {
    expect(clearsOnMain('git pull --ff-only')).toBe(ETriage.Clear)
    expect(
      triageFor({
        evidence: bashEvidence({ command: `git -C ${REPO} pull --ff-only`, facts: inAWorktree() }),
      }).triage,
    ).toBe(ETriage.Clear)
  })

  it('clears copying a file into the main checkout, because an added file takes nothing away', () => {
    expect(clearsInAWorktree(`cp notes.md ${REPO}/notes.md`)).toBe(ETriage.Clear)
  })
})

describe('the stash, which the operator uses to keep work rather than lose it', () => {
  it('clears git stash push, the opposite of losing uncommitted work', () => {
    expect(clearsOnMain('git stash push -m wip')).toBe(ETriage.Clear)
    expect(clearsOnMain('git stash')).toBe(ETriage.Clear)
    expect(clearsOnMain('git stash push -- apps/tui/src')).toBe(ETriage.Clear)
  })
})

describe('a compound command whose damaging verb is in another segment', () => {
  it('clears a rebase that merely follows or precedes a read-only reflog and a plain gc', () => {
    expect(clearsOnMain('git reflog && git rebase origin/main')).toBe(ETriage.Clear)
    expect(clearsOnMain('git rebase origin/main && git gc')).toBe(ETriage.Clear)
  })
})

describe('the bootstrap steps in a fresh worktree', () => {
  it('clears copying .env.keys into a clean sibling worktree, because a copy is not a sink', () => {
    expect(clearsInAWorktree(`cp .env.keys ${SIBLING}/.env.keys`)).toBe(ETriage.Clear)
  })

  it('clears bun install', () => {
    expect(clearsInAWorktree('bun install')).toBe(ETriage.Clear)
  })

  it('clears a compound cd into a package followed by its tests', () => {
    expect(clearsOnMain('cd apps/tui && bun test src/ui/__tests__/paths.spec.ts')).toBe(
      ETriage.Clear,
    )
  })
})

describe('the commands that only report', () => {
  it('clears git stash list, git clean -ndx, gh pr view, aws s3 ls and bun outdated', () => {
    for (const command of [
      'git stash list',
      'git clean -n',
      'git clean -ndx',
      'gh pr view 41',
      'aws s3 ls s3://bucket',
      'bun outdated',
    ]) {
      expect(clearsOnMain(command)).toBe(ETriage.Clear)
    }
  })
})

describe('the commands that merely quote a dangerous one', () => {
  it('clears a grep for "rm -rf" under docs/', () => {
    expect(clearsOnMain('grep -rn "rm -rf" docs/')).toBe(ETriage.Clear)
  })

  it('clears a heredoc that writes a script containing rm -rf /', () => {
    expect(clearsOnMain("cat > scripts/reset.sh <<'EOF'\nrm -rf /\nEOF\n")).toBe(ETriage.Clear)
  })
})

describe('reading, anywhere at all', () => {
  it('clears reads of the main checkout and of another agent worktree', () => {
    const facts = inAWorktree({ siblingChangedCount: 12 })

    for (const command of [`cat ${REPO}/CLAUDE.md`, `rg --files ${SIBLING}/src`]) {
      const evidence = bashEvidence({ command, facts, effect: EToolEffect.Read })
      expect(triageFor({ evidence }).triage).toBe(ETriage.Clear)
    }
  })
})

describe('writes outside the project that are not anybody else work', () => {
  it('clears writes to the operator own tool directories and to the scratchpad', () => {
    for (const path of [
      `${HOME}/.claude/settings.json`,
      `${HOME}/.agents/skills/tdd/SKILL.md`,
      '/private/tmp/claude-501/scratchpad/plan.md',
      `${OURS}/.scratch/auto-classifier/spec.md`,
    ]) {
      const evidence = writeEvidence({ path, facts: inAWorktree() })
      expect(triageFor({ evidence }).triage).toBe(ETriage.Clear)
    }
  })
})

describe('the acknowledged false negative', () => {
  it('clears a script indirection nobody can read, and records that as a known hole', () => {
    expect(clearsOnMain('bun run clean:all')).toBe(ETriage.Clear)
  })
})

describe('the cases the operator captured off their own history', () => {
  for (const entry of readCorpus({ directory: CORPUS_DIRECTORY })) {
    it(`still reads ${entry.name} as ${entry.expect} — ${entry.note}`, () => {
      expect(checkCorpusCase({ entry }).actual).toBe(entry.expect)
    })
  }
})
