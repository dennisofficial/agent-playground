import type { EKilledBy, EventDraft, SaidImage, ThreadId } from '@dltech/atlas-core'

import type { AgentType } from '../types'
import type { AgentSnapshot, RecoveredAgents } from './snapshot'

export type AgentOutcome = { ok: true; snapshot: AgentSnapshot } | { ok: false; reason: string }

/**
 * A sub-agent belongs to the thread that spawned it, so every read and every steer is scoped to
 * that owner; only the exit guard and teardown look across all of them.
 */
export abstract class AgentRegistryPort {
  abstract types(): readonly AgentType[]
  abstract spawn(args: {
    threadId: ThreadId
    agentType: string
    brief: string
    intent: string
  }): Promise<AgentOutcome>
  abstract say(args: {
    agentId: ThreadId
    threadId: ThreadId
    text: string
    images?: readonly SaidImage[] | undefined
  }): Promise<AgentOutcome>
  abstract resume(args: { agentId: ThreadId; threadId: ThreadId }): Promise<AgentOutcome>
  abstract stop(args: { agentId: ThreadId; threadId: ThreadId; by: EKilledBy }): AgentOutcome
  abstract list(args: { threadId: ThreadId }): readonly AgentSnapshot[]
  abstract recordLostAgents(args: { threadId: ThreadId }): Promise<RecoveredAgents>
  abstract listEverywhere(): readonly AgentSnapshot[]
  abstract drainNotifications(args: { threadId: ThreadId }): readonly EventDraft[]
  abstract pendingNotices(args: { threadId: ThreadId }): readonly AgentSnapshot[]
  abstract threadsAwaitingNotice(): readonly ThreadId[]
  abstract onNotice(listener: () => void): () => void
  abstract onChange(listener: () => void): () => void
  abstract forgetNotices(args: { threadId: ThreadId }): void
  abstract closeAll(): Promise<void>
}
