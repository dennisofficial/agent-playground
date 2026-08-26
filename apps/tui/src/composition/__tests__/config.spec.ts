import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_MODEL_ID,
  DEFAULT_THINKING_BUDGET_TOKENS,
  devDatabaseUrl,
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

  it('never falls back to the operator database', () => {
    expect(resolve({}).databaseUrl).toBe(DEV_URL)
    expect(devDatabaseUrl()).not.toContain('harness.db')
  })

  it('names no thinking budget unless the environment asked for one', () => {
    expect(resolve({}).thinkingBudgetTokens).toBeUndefined()
    expect(DEFAULT_THINKING_BUDGET_TOKENS).toBeGreaterThan(0)
  })

  it('opens the most recent conversation unless a fresh one was asked for', () => {
    expect(resolve({}).freshConversation).toBe(false)
    expect(resolve({ argv: ['--new'] }).freshConversation).toBe(true)
    expect(resolve({ argv: ['-n'] }).freshConversation).toBe(true)
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

  it('leaves the keychain service to the backend unless one is named', () => {
    expect(resolve({}).keychainService).toBeUndefined()
    expect(resolve({ env: { ATLAS_KEYCHAIN_SERVICE: 'Atlas-test' } }).keychainService).toBe(
      'Atlas-test',
    )
  })
})
