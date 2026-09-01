import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  toThreadId,
  type ClockPort,
  type EventDraft,
  type EventOfType,
  type ThreadId,
} from '@dltech/atlas-core'

import { HookChain, type HookChainSource } from '../../hooks/registry'
import { EShellStatus } from '../background-shell'
import { BunShellRegistry, type ShellRegistryPort } from '../shell-registry'

export const THREAD = toThreadId('thread-under-test')
export const ELSEWHERE = toThreadId('thread-next-door')

class SteppableClock implements ClockPort {
  private millis = Date.parse('2026-08-27T12:00:00.000Z')

  now(): string {
    return new Date(this.millis).toISOString()
  }

  advance(by: number): void {
    this.millis += by
  }
}

type EndedDraft = Omit<
  EventOfType<'background-shell-ended'>,
  keyof { id: 0; seq: 0; threadId: 0; runId: 0; depth: 0; at: 0 }
>

export function endedDraft(draft: EventDraft | undefined): EndedDraft {
  if (draft?.type !== 'background-shell-ended') {
    throw new Error(`expected a background-shell-ended draft, got ${draft?.type ?? 'nothing'}`)
  }
  return draft
}

type AwaitingInputDraft = Omit<
  EventOfType<'background-shell-awaiting-input'>,
  keyof { id: 0; seq: 0; threadId: 0; runId: 0; depth: 0; at: 0 }
>

export function awaitingInputDraft(draft: EventDraft | undefined): AwaitingInputDraft {
  if (draft?.type !== 'background-shell-awaiting-input') {
    throw new Error(
      `expected a background-shell-awaiting-input draft, got ${draft?.type ?? 'nothing'}`,
    )
  }
  return draft
}

type MatchedDraft = Omit<
  EventOfType<'background-shell-matched'>,
  keyof { id: 0; seq: 0; threadId: 0; runId: 0; depth: 0; at: 0 }
>

export function matchedDraft(draft: EventDraft | undefined): MatchedDraft {
  if (draft?.type !== 'background-shell-matched') {
    throw new Error(`expected a background-shell-matched draft, got ${draft?.type ?? 'nothing'}`)
  }
  return draft
}

const opened: { registry: ShellRegistryPort; root: string }[] = []

export async function closeRegistries(): Promise<void> {
  for (const entry of opened.splice(0)) {
    await entry.registry.closeAll()
    rmSync(entry.root, { recursive: true, force: true })
  }
}

const noHooks: HookChainSource = () => new HookChain({})

export function openRegistry(
  { hooks }: { hooks?: HookChainSource | undefined } = {},
): {
  registry: BunShellRegistry
  clock: SteppableClock
  root: string
} {
  const root = mkdtempSync(join(tmpdir(), 'atlas-shells-'))
  const clock = new SteppableClock()
  const registry = new BunShellRegistry(root, clock, hooks ?? noHooks)
  opened.push({ registry, root })
  return { registry, clock, root }
}

export const job = ({ command, threadId = THREAD }: { command: string; threadId?: ThreadId }) => ({
  threadId,
  description: 'Run a background job',
  command,
})

export async function settle({
  registry,
  shellId,
  threadId = THREAD,
}: {
  registry: ShellRegistryPort
  shellId: string
  threadId?: ThreadId
}): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = registry.list({ threadId }).find((entry) => entry.shellId === shellId)
    if (snapshot !== undefined && snapshot.status !== EShellStatus.Running) return
    await Bun.sleep(25)
  }
  throw new Error(`background shell ${shellId} never left running`)
}

/**
 * A kill flips the status synchronously but the ending is announced when the process is reaped, so
 * waiting on the status is not waiting on the notice.
 */
export async function announced({
  registry,
  threadId = THREAD,
}: {
  registry: ShellRegistryPort
  threadId?: ThreadId
}): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (registry.pendingNotices({ threadId }).length > 0) return
    await Bun.sleep(25)
  }
  throw new Error('no background shell ending was ever announced')
}

export const awaitingInputOf = async ({
  registry,
  shellId,
}: {
  registry: ShellRegistryPort
  shellId: string
}): Promise<boolean> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = registry.list({ threadId: THREAD }).find((entry) => entry.shellId === shellId)
    if (snapshot?.awaitingInput === true) return true
    await Bun.sleep(25)
  }
  return false
}
