import { describe, expect, it } from 'bun:test'

import { EDeed, EDeedRealm } from '../../../deed'
import { oneDeed, PROJECT } from './read-deeds'

const actionOf = (command: string): EDeed => oneDeed({ command }).action

describe('the package manager verbs', () => {
  it('reads every install verb as a dependency change', () => {
    for (const command of [
      'bun install',
      'bun add zod',
      'bun update',
      'bun remove zod',
      'npm ci',
      'pnpm install --frozen-lockfile',
      'yarn add react',
      'pip install requests',
      'cargo add serde',
      'brew install jq',
    ]) {
      expect(actionOf(command)).toBe(EDeed.MutateDependencies)
    }
  })

  it('names the packages and the workspace the change lands in', () => {
    const deed = oneDeed({ command: 'bun add zod @dltech/x' })

    expect(deed.targets).toEqual([
      { realm: EDeedRealm.Package, value: 'zod' },
      { realm: EDeedRealm.Package, value: '@dltech/x' },
      { realm: EDeedRealm.Path, value: PROJECT },
    ])
  })

  it('keeps the reading verbs read-only', () => {
    for (const command of [
      'bun outdated',
      'npm view zod',
      'bun pm untrusted',
      'npm audit',
      'brew list',
    ]) {
      expect(actionOf(command)).toBe(EDeed.ReadOnly)
    }
  })

  it('separates bun pm trust from bun pm untrusted', () => {
    expect(actionOf('bun pm trust esbuild')).toBe(EDeed.MutateDependencies)
    expect(actionOf('bun pm untrusted')).toBe(EDeed.ReadOnly)
  })

  it('leaves the runner verbs of the same programs to the routine table', () => {
    expect(actionOf('bun test')).toBe(EDeed.Routine)
    expect(actionOf('cargo build')).toBe(EDeed.Routine)
    expect(actionOf('go test ./...')).toBe(EDeed.Routine)
  })
})
