import { describe, expect, it } from 'bun:test'

import { EToolEffect, toCallId, toRunId, toThreadId } from '@dltech/atlas-core'
import { ETurnStatus } from '@dltech/atlas-harness'

import {
  createWarpReporter,
  reportWarpOutcome,
  WarpThreadOpenHook,
  WarpToolCompleteHook,
  type WarpReporter,
} from '../warp-reporter'
import { fakeEventLog } from './fake-backend'

const WARP_ENV = {
  WARP_CLI_AGENT_PROTOCOL_VERSION: '1',
  WARP_CLIENT_VERSION: 'v0.2026.09.01.08.00.stable_00',
}

const THREAD = toThreadId('thread-warp')

function capturedReporter(): { reporter: WarpReporter; writes: string[] } {
  const writes: string[] = []
  const reporter = createWarpReporter({
    env: WARP_ENV,
    write: (sequence) => writes.push(sequence),
    version: '0.4.2',
  })
  if (reporter === null) throw new Error('expected a reporter for a capable Warp')
  return { reporter, writes }
}

function payloadsOf(writes: readonly string[]): Record<string, unknown>[] {
  return writes.map((write) => {
    expect(write.startsWith('\x1b]777;notify;warp://cli-agent;')).toBe(true)
    expect(write.endsWith('\x07')).toBe(true)
    return JSON.parse(write.slice('\x1b]777;notify;warp://cli-agent;'.length, -1))
  })
}

describe('createWarpReporter', () => {
  it('is null outside a capable Warp build', () => {
    expect(
      createWarpReporter({ env: {}, write: () => undefined, version: '0.4.2' }),
    ).toBeNull()
  })

  it('creates a reporter when Warp advertises the protocol', () => {
    expect(
      createWarpReporter({ env: WARP_ENV, write: () => undefined, version: '0.4.2' }),
    ).not.toBeNull()
  })
})

describe('OscWarpReporter', () => {
  it('emits nothing before a thread has been opened', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handlePromptSubmit({ text: 'hello' })
    expect(writes).toEqual([])
  })

  it('emits session_start with the plugin version when a thread opens', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ threadId: THREAD, projectDirectory: '/Users/dennis/atlas' })

    expect(payloadsOf(writes)).toEqual([
      {
        v: 1,
        agent: 'atlas',
        event: 'session_start',
        session_id: THREAD,
        cwd: '/Users/dennis/atlas',
        project: 'atlas',
        plugin_version: '0.4.2',
      },
    ])
  })

  it('scopes later events to the most recently opened thread', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ threadId: THREAD, projectDirectory: '/Users/dennis/atlas' })
    reporter.handlePromptSubmit({ text: 'fix it' })
    reporter.handleToolComplete({ toolName: 'edit' })
    reporter.handleTurnCompleted({ query: 'fix it', response: 'fixed' })

    const [sessionStart, promptSubmit, toolComplete, stop] = payloadsOf(writes)
    expect(sessionStart?.event).toBe('session_start')
    expect(promptSubmit).toMatchObject({ event: 'prompt_submit', query: 'fix it' })
    expect(toolComplete).toMatchObject({ event: 'tool_complete', tool_name: 'edit' })
    expect(stop).toMatchObject({ event: 'stop', query: 'fix it', response: 'fixed' })
    for (const payload of payloadsOf(writes)) {
      expect(payload.session_id).toBe(THREAD)
    }
  })

  it('emits permission_request with summary and tool fields', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ threadId: THREAD, projectDirectory: '/x' })
    reporter.handlePermissionRequest({
      summary: 'Wants to run bash: rm -rf build',
      toolName: 'bash',
      toolInput: { command: 'rm -rf build' },
    })

    expect(payloadsOf(writes).at(-1)).toMatchObject({
      event: 'permission_request',
      summary: 'Wants to run bash: rm -rf build',
      tool_name: 'bash',
      tool_input: { command: 'rm -rf build' },
    })
  })

  it('survives a write that throws', () => {
    const reporter = createWarpReporter({
      env: WARP_ENV,
      write: () => {
        throw new Error('EPIPE')
      },
      version: '0.4.2',
    })
    reporter?.handleThreadOpened({ threadId: THREAD, projectDirectory: '/x' })
    reporter?.handlePromptSubmit({ text: 'still alive' })
  })
})

describe('the hook adapters', () => {
  it('WarpThreadOpenHook forwards the opened thread', async () => {
    const { reporter, writes } = capturedReporter()
    const hook = new WarpThreadOpenHook(reporter)
    const outcome = await hook.run({ threadId: THREAD, projectDirectory: '/Users/dennis/atlas' })

    expect(outcome).toEqual({})
    expect(payloadsOf(writes).at(-1)?.event).toBe('session_start')
  })

  it('WarpToolCompleteHook forwards the tool name', async () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ threadId: THREAD, projectDirectory: '/x' })
    const hook = new WarpToolCompleteHook(reporter)
    const outcome = await hook.run({
      call: {
        callId: toCallId('call-1'),
        name: 'bash',
        input: { command: 'ls' },
        effect: EToolEffect.Write,
        threadId: THREAD,
      },
      result: { ok: true, output: 'done', modelText: 'done' },
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({})
    expect(payloadsOf(writes).at(-1)).toMatchObject({
      event: 'tool_complete',
      tool_name: 'bash',
    })
  })
})

describe('reportWarpOutcome', () => {
  it('does nothing without a reporter', async () => {
    const log = fakeEventLog()
    await reportWarpOutcome({
      reporter: null,
      log,
      threadId: THREAD,
      outcome: { status: ETurnStatus.Completed, runId: toRunId('run-1') },
      asked: null,
    })
    expect(log.branchesRead).toEqual([])
  })

  it('reports stop with the trailing prompt and response on a completed turn', async () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ threadId: THREAD, projectDirectory: '/x' })
    writes.length = 0

    const log = fakeEventLog()
    await log.append({
      threadId: THREAD,
      runId: toRunId('run-1'),
      drafts: [
        { type: 'user-said', text: 'ship it' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'shipped' }] },
      ],
    })

    await reportWarpOutcome({
      reporter,
      log,
      threadId: THREAD,
      outcome: { status: ETurnStatus.Completed, runId: toRunId('run-1') },
      asked: null,
    })

    expect(payloadsOf(writes).at(-1)).toMatchObject({
      event: 'stop',
      query: 'ship it',
      response: 'shipped',
    })
  })

  it('reports permission_request joined back to the tool call', async () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ threadId: THREAD, projectDirectory: '/x' })
    writes.length = 0

    const log = fakeEventLog()
    await log.append({
      threadId: THREAD,
      runId: toRunId('run-1'),
      drafts: [
        { type: 'user-said', text: 'clean up' },
        {
          type: 'tool-called',
          callId: toCallId('call-9'),
          name: 'bash',
          input: { command: 'rm -rf dist' },
          ordinal: 0,
        },
        { type: 'approval-requested', callId: toCallId('call-9'), reason: 'destructive' },
      ],
    })

    await reportWarpOutcome({
      reporter,
      log,
      threadId: THREAD,
      outcome: {
        status: ETurnStatus.Paused,
        runId: toRunId('run-1'),
        callId: toCallId('call-9'),
        reason: 'destructive',
      },
      asked: { callId: toCallId('call-9'), reason: 'destructive', evidence: [], dimensions: [] },
    })

    expect(payloadsOf(writes).at(-1)).toMatchObject({
      event: 'permission_request',
      summary: 'Wants to run bash: rm -rf dist',
      tool_name: 'bash',
    })
  })

  it('stays quiet on an interrupted turn', async () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ threadId: THREAD, projectDirectory: '/x' })
    writes.length = 0

    await reportWarpOutcome({
      reporter,
      log: fakeEventLog(),
      threadId: THREAD,
      outcome: { status: ETurnStatus.Interrupted, runId: toRunId('run-1'), committed: false },
      asked: null,
    })

    expect(writes).toEqual([])
  })
})
