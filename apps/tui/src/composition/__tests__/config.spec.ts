import { describe, expect, it } from 'bun:test'

import { homedir } from 'node:os'

import { atlasDatabaseUrl } from '@dltech/atlas-harness'

import {
  DEFAULT_MODEL_ID,
  DEFAULT_THINKING_BUDGET_TOKENS,
  EOpenMode,
  resolveConfig,
  type AtlasConfig,
} from '../config'

const DEV_URL = 'file:/tmp/atlas-dev.db'

const resolve = (args: {
  argv?: readonly string[]
  env?: Record<string, string | undefined>
}): AtlasConfig =>
  resolveConfig({
    argv: args.argv ?? [],
    env: args.env ?? {},
    cwd: '/work',
    defaultDatabaseUrl: DEV_URL,
  })

describe('the launch configuration', () => {
  it('names no model unless the launch asked for one, so a remembered pick can answer', () => {
    expect(resolve({}).modelId).toBeUndefined()
    expect(DEFAULT_MODEL_ID).toBe('claude-haiku-4-5-20251001')
  })

  it('never falls back to the operator database when it was launched from source', () => {
    expect(resolve({}).databaseUrl).toBe(DEV_URL)
    expect(atlasDatabaseUrl()).toContain('/.atlas-home/')
    expect(atlasDatabaseUrl()).not.toContain(`${homedir()}/.atlas/`)
  })

  it('names no thinking budget unless the environment asked for one', () => {
    expect(resolve({}).thinkingBudgetTokens).toBeUndefined()
    expect(DEFAULT_THINKING_BUDGET_TOKENS).toBeGreaterThan(0)
  })

  it('opens a new conversation unless the launch asked to come back to one', () => {
    expect(resolve({}).open).toEqual({ mode: EOpenMode.New })
    expect(resolve({ argv: ['--new'] }).open).toEqual({ mode: EOpenMode.New })
    expect(resolve({ argv: ['-n'] }).open).toEqual({ mode: EOpenMode.New })
  })

  it('continues the most recent conversation when asked', () => {
    expect(resolve({ argv: ['--continue'] }).open).toEqual({ mode: EOpenMode.Continue })
    expect(resolve({ argv: ['-c'] }).open).toEqual({ mode: EOpenMode.Continue })
  })

  it('resumes the conversation named on the command line', () => {
    expect(resolve({ argv: ['--resume', 'brn_1'] }).open).toEqual({
      mode: EOpenMode.Resume,
      threadId: 'brn_1',
    })
  })

  it('falls back to the most recent for a bare --resume, until a picker can ask', () => {
    expect(resolve({ argv: ['--resume'] }).open).toEqual({ mode: EOpenMode.Continue })
    expect(resolve({ argv: ['--resume', '--new'] }).open).toEqual({ mode: EOpenMode.Continue })
  })

  it('takes a named thread ahead of a bare continue', () => {
    expect(resolve({ argv: ['--continue', '--resume', 'brn_2'] }).open).toEqual({
      mode: EOpenMode.Resume,
      threadId: 'brn_2',
    })
  })

  it('takes the model from the command line ahead of the environment', () => {
    expect(resolve({ argv: ['--model', 'claude-sonnet-5'], env: { ATLAS_MODEL: 'x' } }).modelId).toBe(
      'claude-sonnet-5',
    )
    expect(resolve({ env: { ATLAS_MODEL: 'claude-opus-5' } }).modelId).toBe('claude-opus-5')
  })

  it('ignores a --model with no model after it', () => {
    expect(resolve({ argv: ['--model'] }).modelId).toBeUndefined()
    expect(resolve({ argv: ['--model', '--new'] }).modelId).toBeUndefined()
  })

  it('takes an explicit database url from the environment', () => {
    expect(resolve({ env: { ATLAS_DATABASE_URL: 'file:/tmp/other.db' } }).databaseUrl).toBe(
      'file:/tmp/other.db',
    )
  })

  it('ignores a thinking budget that is not a positive integer', () => {
    expect(resolve({ env: { ATLAS_THINKING_BUDGET: 'lots' } }).thinkingBudgetTokens).toBeUndefined()
    expect(resolve({ env: { ATLAS_THINKING_BUDGET: '0' } }).thinkingBudgetTokens).toBeUndefined()
    expect(resolve({ env: { ATLAS_THINKING_BUDGET: '4096' } }).thinkingBudgetTokens).toBe(4096)
  })

  it('carries the working directory through, because the empty transcript names it', () => {
    expect(resolve({}).cwd).toBe('/work')
  })

  it('works in the directory named on the command line, so a source launch can open another project', () => {
    expect(resolve({ argv: ['--cwd', '/Users/ada/dev/comp'] }).cwd).toBe('/Users/ada/dev/comp')
  })

  it('reads a relative directory against the directory it was launched from', () => {
    expect(resolve({ argv: ['--cwd', '../comp'] }).cwd).toBe('/comp')
    expect(resolve({ argv: ['--cwd', '.'] }).cwd).toBe('/work')
  })

  it('expands a leading ~ itself, because a quoted argument reaches it unexpanded', () => {
    expect(resolve({ argv: ['--cwd', '~/dev/comp'], env: { HOME: '/Users/ada' } }).cwd).toBe(
      '/Users/ada/dev/comp',
    )
    expect(resolve({ argv: ['--cwd', '~'], env: { HOME: '/Users/ada' } }).cwd).toBe('/Users/ada')
  })

  it('drops a trailing separator, because the workspace root anchors path comparisons', () => {
    expect(resolve({ argv: ['--cwd', '/Users/ada/dev/comp/'] }).cwd).toBe('/Users/ada/dev/comp')
  })

  it('stays where it was launched when --cwd names no directory', () => {
    expect(resolve({ argv: ['--cwd'] }).cwd).toBe('/work')
    expect(resolve({ argv: ['--cwd', '--continue'] }).cwd).toBe('/work')
  })

  it('lets every child inherit the parent model unless a subagent model is named', () => {
    expect(resolve({}).subagentModelId).toBeUndefined()
    expect(resolve({ env: { ATLAS_SUBAGENT_MODEL: '' } }).subagentModelId).toBeUndefined()
  })

  it('takes the model every child runs on from the environment', () => {
    expect(resolve({ env: { ATLAS_SUBAGENT_MODEL: 'claude-haiku-4-5' } }).subagentModelId).toBe(
      'claude-haiku-4-5',
    )
  })

  it('keeps the subagent model apart from the model the parent runs on', () => {
    const config = resolve({
      argv: ['--model', 'claude-opus-5'],
      env: { ATLAS_SUBAGENT_MODEL: 'claude-haiku-4-5' },
    })

    expect(config.modelId).toBe('claude-opus-5')
    expect(config.subagentModelId).toBe('claude-haiku-4-5')
  })

  it('leaves the keychain service to the backend unless one is named', () => {
    expect(resolve({}).keychainService).toBeUndefined()
    expect(resolve({ env: { ATLAS_KEYCHAIN_SERVICE: 'Atlas-test' } }).keychainService).toBe(
      'Atlas-test',
    )
  })
})
