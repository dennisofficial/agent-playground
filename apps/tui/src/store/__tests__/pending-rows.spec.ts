import { describe, expect, it } from 'bun:test'

import { EAgentStatus, EKilledBy, EServiceStatus, EShellStatus, toThreadId } from '@dltech/atlas-core'
import {
  ENotice,
  toShellId,
  type AgentSnapshot,
  type PendingShellNotice,
  type ServiceSnapshot,
  type ShellSnapshot,
} from '@dltech/atlas-harness'

import { EPendingKind, pendingRows } from '../pending-rows'

const typed = (id: string, text: string, taken = false) => ({ id, text, taken, images: [] })

const service = (over: Partial<ServiceSnapshot> = {}): ServiceSnapshot => ({
  serviceId: 'svc_1',
  command: 'bun run dev',
  description: 'web dev server',
  status: EServiceStatus.Exited,
  exitCode: 0,
  pid: 4_242,
  logPath: '/tmp/atlas/services/svc_1.log',
  startedAt: '2026-08-27T12:00:00.000Z',
  endedAt: '2026-08-27T12:01:00.000Z',
  ...over,
})

const snapshot = (over: Partial<ShellSnapshot> = {}): ShellSnapshot =>
  ({
    shellId: toShellId('bash_1'),
    command: 'bun test',
    description: 'Run full TUI suite',
    status: EShellStatus.Exited,
    exitCode: 0,
    pid: 4_242,
    startedAt: '2026-08-27T12:00:00.000Z',
    lastOutputAt: '2026-08-27T12:00:01.000Z',
    totalCharacters: 18,
    awaitingInput: false,
    ...over,
  }) as ShellSnapshot

const notice = (
  over: Partial<ShellSnapshot> = {},
  kind: ENotice = ENotice.Ended,
): PendingShellNotice => ({ kind, snapshot: snapshot(over) })

const child = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  agentId: toThreadId('thread-child'),
  spawnedBy: toThreadId('thread-parent'),
  agentType: 'explore',
  intent: 'audit the credential vault',
  status: EAgentStatus.Finished,
  turns: 3,
  toolCalls: 12,
  lastTool: 'grep',
  startedAt: '2026-08-27T12:00:00.000Z',
  endedAt: '2026-08-27T12:04:00.000Z',
  ...over,
})

describe('what waits under the working indicator', () => {
  it('is nothing at all when neither a message nor an ending is waiting', () => {
    expect(pendingRows({ messages: [], notices: [], agents: [], services: [] })).toEqual([])
  })

  it('queues a shell ending behind the messages a human typed', () => {
    const rows = pendingRows({
      messages: [typed('p1', 'and the fixtures')],
      notices: [notice()],
      agents: [],
      services: [],
    })

    expect(rows.map((row) => row.kind)).toEqual([
      EPendingKind.Operator,
      EPendingKind.BackgroundShell,
    ])
  })

  it('reads a queued ending the same way the transcript will', () => {
    const rows = pendingRows({ messages: [], notices: [notice()], agents: [], services: [] })

    expect(rows[0]).toEqual({
      kind: EPendingKind.BackgroundShell,
      id: 'shell-ended-bash_1',
      text: 'Background shell "Run full TUI suite" completed (exit code 0)',
      failed: false,
    })
  })

  it('carries no take-back or taken flag, because nobody sent it', () => {
    const row = pendingRows({ messages: [], notices: [notice()], agents: [], services: [] })[0]

    expect(row === undefined ? null : 'taken' in row).toBe(false)
  })

  it('marks a failure so the queued line is not read as good news', () => {
    const rows = pendingRows({
      messages: [],
      notices: [notice({ exitCode: 2 })],
      agents: [],
      services: [],
    })

    expect(rows[0]?.kind === EPendingKind.BackgroundShell && rows[0].failed).toBe(true)
  })

  it('queues a sub-agent ending behind the shells and the messages alike', () => {
    const rows = pendingRows({
      messages: [typed('p1', 'and the fixtures')],
      notices: [notice()],
      agents: [child()],
      services: [],
    })

    expect(rows.map((row) => row.kind)).toEqual([
      EPendingKind.Operator,
      EPendingKind.BackgroundShell,
      EPendingKind.Agent,
    ])
  })

  it('reads a queued sub-agent ending the same way the transcript will', () => {
    const rows = pendingRows({ messages: [], notices: [], agents: [child()], services: [] })

    expect(rows[0]).toEqual({
      kind: EPendingKind.Agent,
      id: 'agent-finished-thread-child',
      text: 'Sub-agent explore "audit the credential vault" finished after 3 turns and 12 tool calls',
      failed: false,
    })
  })

  it('marks a child that failed, and leaves one the operator stopped alone', () => {
    const rows = pendingRows({
      messages: [],
      notices: [],
      agents: [child({ status: EAgentStatus.Failed }), child({ status: EAgentStatus.Stopped })],
      services: [],
    })

    expect(rows.map((row) => row.kind === EPendingKind.Agent && row.failed)).toEqual([true, false])
  })

  it('keeps a child noticed twice as two rows, because the second notice is a different state', () => {
    const rows = pendingRows({
      messages: [],
      notices: [],
      agents: [child({ status: EAgentStatus.Blocked }), child()],
      services: [],
    })

    expect(rows.map((row) => row.id)).toEqual([
      'agent-blocked-thread-child',
      'agent-finished-thread-child',
    ])
  })

  it('is still nothing at all when only an empty wave of children is passed', () => {
    expect(pendingRows({ messages: [], notices: [], agents: [], services: [] })).toEqual([])
  })

  it('keys each ending by its shell, so two waiting endings stay distinct', () => {
    const rows = pendingRows({
      messages: [],
      notices: [notice(), notice({ shellId: toShellId('bash_2'), description: 'Watch the docs' })],
      agents: [],
      services: [],
    })

    expect(rows.map((row) => row.id)).toEqual(['shell-ended-bash_1', 'shell-ended-bash_2'])
  })

  it('reads a queued check-in as a shell still running, never as a prompt to answer', () => {
    const rows = pendingRows({
      messages: [],
      notices: [notice({ status: EShellStatus.Running }, ENotice.StillRunning)],
      agents: [],
      services: [],
    })

    expect(rows[0]).toEqual({
      kind: EPendingKind.BackgroundShell,
      id: 'shell-still-running-bash_1',
      text: 'Background shell "Run full TUI suite" is still running - a scheduled check-in, not an ending',
      failed: false,
    })
  })

  it('reads a queued watch match as progress, not as a prompt to answer', () => {
    const rows = pendingRows({
      messages: [],
      notices: [notice({ status: EShellStatus.Running }, ENotice.Matched)],
      agents: [],
      services: [],
    })

    expect(rows[0]).toEqual({
      kind: EPendingKind.BackgroundShell,
      id: 'shell-matched-bash_1',
      text: 'Background shell "Run full TUI suite" matched its watch and is still running',
      failed: false,
    })
  })

  it('queues a service ending behind everything else and reads it the way the transcript will', () => {
    const rows = pendingRows({
      messages: [typed('p1', 'and the fixtures')],
      notices: [],
      agents: [],
      services: [service()],
    })

    expect(rows.map((row) => row.kind)).toEqual([EPendingKind.Operator, EPendingKind.Service])
    expect(rows[1]).toEqual({
      kind: EPendingKind.Service,
      id: 'service-exited-svc_1',
      text: 'Service svc_1 "web dev server" exited cleanly',
      failed: false,
    })
  })

  it('marks a service that died on its own as failed, and one the operator stopped alone', () => {
    const rows = pendingRows({
      messages: [],
      notices: [],
      agents: [],
      services: [
        service({ exitCode: 1 }),
        service({ status: EServiceStatus.Killed, killedBy: EKilledBy.User, exitCode: undefined }),
      ],
    })

    expect(rows.map((row) => row.kind === EPendingKind.Service && row.failed)).toEqual([true, false])
  })
})
