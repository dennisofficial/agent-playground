import { describe, expect, it } from 'bun:test'

import {
  buildWarpOscSequence,
  buildWarpPayload,
  EWarpAgentEvent,
  truncateForWarpNotification,
} from '../payload'

describe('buildWarpPayload', () => {
  it('builds the common fields with the atlas agent name', () => {
    const json = buildWarpPayload({
      event: EWarpAgentEvent.SessionStart,
      sessionId: 'session-1',
      cwd: '/Users/dennis/Developer/atlas',
      protocolVersion: 1,
    })
    expect(JSON.parse(json)).toEqual({
      v: 1,
      agent: 'atlas',
      event: 'session_start',
      session_id: 'session-1',
      cwd: '/Users/dennis/Developer/atlas',
      project: 'atlas',
    })
  })

  it('derives the project from the last path segment', () => {
    const json = buildWarpPayload({
      event: EWarpAgentEvent.PromptSubmit,
      sessionId: 's',
      cwd: '/Users/dennis/Developer/atlas/.atlas/worktrees/warp-integration',
      protocolVersion: 1,
    })
    expect(JSON.parse(json).project).toBe('warp-integration')
  })

  it('includes the plugin version on session start', () => {
    const json = buildWarpPayload({
      event: EWarpAgentEvent.SessionStart,
      sessionId: 's',
      cwd: '/x',
      protocolVersion: 1,
      extras: { pluginVersion: '0.4.2' },
    })
    expect(JSON.parse(json).plugin_version).toBe('0.4.2')
  })

  it('includes query and response on stop', () => {
    const json = buildWarpPayload({
      event: EWarpAgentEvent.Stop,
      sessionId: 's',
      cwd: '/x',
      protocolVersion: 1,
      extras: { query: 'fix the bug', response: 'done' },
    })
    const parsed = JSON.parse(json)
    expect(parsed.query).toBe('fix the bug')
    expect(parsed.response).toBe('done')
  })

  it('includes tool fields on permission request', () => {
    const json = buildWarpPayload({
      event: EWarpAgentEvent.PermissionRequest,
      sessionId: 's',
      cwd: '/x',
      protocolVersion: 1,
      extras: {
        summary: 'Wants to run bash: rm -rf build',
        toolName: 'bash',
        toolInput: { command: 'rm -rf build' },
      },
    })
    const parsed = JSON.parse(json)
    expect(parsed.summary).toBe('Wants to run bash: rm -rf build')
    expect(parsed.tool_name).toBe('bash')
    expect(parsed.tool_input).toEqual({ command: 'rm -rf build' })
  })

  it('truncates long queries and responses to 200 chars', () => {
    const long = 'a'.repeat(500)
    const json = buildWarpPayload({
      event: EWarpAgentEvent.Stop,
      sessionId: 's',
      cwd: '/x',
      protocolVersion: 1,
      extras: { query: long, response: long },
    })
    const parsed = JSON.parse(json)
    expect(parsed.query).toBe(`${'a'.repeat(197)}...`)
    expect(parsed.response).toBe(`${'a'.repeat(197)}...`)
  })
})

describe('truncateForWarpNotification', () => {
  it('leaves short text alone', () => {
    expect(truncateForWarpNotification({ text: 'short' })).toBe('short')
  })

  it('truncates at the limit with an ellipsis', () => {
    const text = 'b'.repeat(201)
    expect(truncateForWarpNotification({ text })).toBe(`${'b'.repeat(197)}...`)
  })
})

describe('buildWarpOscSequence', () => {
  it('wraps the payload in an OSC 777 sequence targeting warp://cli-agent', () => {
    const payloadJson = buildWarpPayload({
      event: EWarpAgentEvent.IdlePrompt,
      sessionId: 's',
      cwd: '/x',
      protocolVersion: 1,
      extras: { summary: 'Input needed' },
    })
    const sequence = buildWarpOscSequence({ payloadJson })
    expect(sequence).toBe(`\x1b]777;notify;warp://cli-agent;${payloadJson}\x07`)
  })

  it('produces a sequence without raw control characters inside the payload', () => {
    const payloadJson = buildWarpPayload({
      event: EWarpAgentEvent.PromptSubmit,
      sessionId: 's',
      cwd: '/x',
      protocolVersion: 1,
      extras: { query: 'line one\nline two' },
    })
    expect(payloadJson).not.toContain('\n')
    const sequence = buildWarpOscSequence({ payloadJson })
    expect(sequence.startsWith('\x1b]777;')).toBe(true)
    expect(sequence.endsWith('\x07')).toBe(true)
  })
})
