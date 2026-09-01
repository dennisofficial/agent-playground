import { describe, expect, it } from 'bun:test'

import { EDeed } from '../../../deed'
import { actionsFor, oneDeed } from './read-deeds'

const actionOf = (command: string): EDeed => oneDeed({ command }).action

const quiet = (action: EDeed): boolean => action === EDeed.Routine || action === EDeed.ReadOnly

describe('the routine table, which carries the false-positive budget', () => {
  it('keeps every build and test runner routine', () => {
    for (const command of [
      'bun test',
      'bun run typecheck',
      'bun build ./src/index.ts',
      'turbo run test',
      'tsc --noEmit',
      'node scripts/x.mjs',
      'make test',
      'vitest run',
      'eslint .',
      'prettier --check .',
    ]) {
      expect(quiet(actionOf(command))).toBe(true)
    }
  })

  it('keeps every everyday reader read-only', () => {
    for (const command of [
      'echo hello',
      'cat package.json',
      'ls -la',
      'grep -rn "rm -rf" docs/',
      'rg --files',
      'fd -e ts',
      'jq .name package.json',
      'sed -n 1,20p file.ts',
      'head -20 file.ts',
      'tail -f log.txt',
      'which bun',
      'env',
    ]) {
      expect(actionOf(command)).toBe(EDeed.ReadOnly)
    }
  })

  it('folds a leading cd into the segment that follows and leaves both routine', () => {
    expect(actionsFor({ command: 'cd apps/tui && bun test x' })).toEqual([
      EDeed.Routine,
      EDeed.Routine,
    ])

    const [, testRun] = actionsFor({ command: 'cd apps/tui && bun test x' })
    expect(testRun).toBe(EDeed.Routine)
  })

  it('sees through the wrappers that stand in front of the real program', () => {
    expect(actionOf('timeout 30 bun test')).toBe(EDeed.Routine)
    expect(actionOf('nice -n 10 tsc --noEmit')).toBe(EDeed.Routine)
    expect(actionOf('env FORCE_COLOR=1 bun test')).toBe(EDeed.Routine)
  })

  it('refuses to guess at make clean, where the target is a script it cannot read', () => {
    expect(actionOf('make test')).toBe(EDeed.Routine)
    expect(actionOf('make clean')).toBe(EDeed.Unreadable)
  })

  it('refuses to guess at a program it has never heard of', () => {
    expect(actionOf('./scripts/reset.sh')).toBe(EDeed.Unreadable)
    expect(actionOf('bunx some-tool')).toBe(EDeed.Unreadable)
  })

  it('never lets a quoted dangerous string escalate the deed', () => {
    const deed = oneDeed({ command: 'grep -rn "git reset --hard" docs/' })

    expect(deed.action).toBe(EDeed.ReadOnly)
  })
})
