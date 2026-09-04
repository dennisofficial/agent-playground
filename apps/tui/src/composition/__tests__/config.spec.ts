import { describe, expect, it } from 'bun:test'

import { homedir } from 'node:os'

import { atlasDatabaseUrl } from '@dltech/atlas-harness'

import { refKey } from '@dltech/atlas-core'

import { DEFAULT_MODEL_REF, EOpenMode, resolveConfig, type AtlasConfig } from '../config'

const resolve = (args: { argv?: readonly string[]; home?: string }): AtlasConfig =>
  resolveConfig({
    argv: args.argv ?? [],
    cwd: '/work',
    home: args.home,
  })

describe('the launch configuration', () => {
  it('names no model unless the launch asked for one, so a remembered pick can answer', () => {
    expect(resolve({}).model).toBeUndefined()
    expect(refKey(DEFAULT_MODEL_REF)).toBe('anthropic/claude-haiku-4-5')
  })

  it('never falls back to the operator database when it was launched from source', () => {
    expect(atlasDatabaseUrl()).toContain('/.atlas-home/')
    expect(atlasDatabaseUrl()).not.toContain(`${homedir()}/.atlas/`)
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

  it('takes the model from the command line, overriding the remembered pick for one launch', () => {
    expect(resolve({ argv: ['--model', 'claude-sonnet-5'] }).model).toBe('claude-sonnet-5')
  })

  it('ignores a --model with no model after it', () => {
    expect(resolve({ argv: ['--model'] }).model).toBeUndefined()
    expect(resolve({ argv: ['--model', '--new'] }).model).toBeUndefined()
  })

  it('reads nothing out of the environment, because every such knob is a setting', () => {
    expect(Object.keys(resolve({}))).toEqual(['model', 'executionLocation', 'open', 'cwd'])
  })

  it('names no execution location unless the launch asked for one, so the thread or the default answers', () => {
    expect(resolve({}).executionLocation).toBeUndefined()
  })

  it('takes the execution location from the command line, overriding for one launch only', () => {
    expect(resolve({ argv: ['--execution-location', 'docker'] }).executionLocation).toBe('docker')
  })

  it('ignores an --execution-location with no location after it', () => {
    expect(resolve({ argv: ['--execution-location'] }).executionLocation).toBeUndefined()
    expect(
      resolve({ argv: ['--execution-location', '--new'] }).executionLocation,
    ).toBeUndefined()
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
    expect(resolve({ argv: ['--cwd', '~/dev/comp'], home: '/Users/ada' }).cwd).toBe(
      '/Users/ada/dev/comp',
    )
    expect(resolve({ argv: ['--cwd', '~'], home: '/Users/ada' }).cwd).toBe('/Users/ada')
  })

  it('drops a trailing separator, because the workspace root anchors path comparisons', () => {
    expect(resolve({ argv: ['--cwd', '/Users/ada/dev/comp/'] }).cwd).toBe('/Users/ada/dev/comp')
  })

  it('stays where it was launched when --cwd names no directory', () => {
    expect(resolve({ argv: ['--cwd'] }).cwd).toBe('/work')
    expect(resolve({ argv: ['--cwd', '--continue'] }).cwd).toBe('/work')
  })
})
