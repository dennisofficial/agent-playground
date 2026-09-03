import {
  projectOf,
  toThreadId,
  type IdPort,
  type ThreadId,
  type Event,
  type EventLogPort,
  type WorkspaceIdentity,
} from '@dltech/atlas-core'
import type {
  AgentRegistryPort,
  RecoveredAgents,
  ThreadModel,
  ThreadStorePort,
  ThreadSummary,
  TurnLedgerPort,
  TurnSpend,
} from '@dltech/atlas-harness'

import { EOpenMode, type OpenRequest } from './config'
import { readThreadSpend } from './thread-spend'
import { slugOfTitle } from './thread-slug'

/**
 * `started` is what the store knows, not what the screen shows: a conversation nobody has spoken in
 * holds an id that has been handed out but never written, so the first turn opens the thread rather
 * than appending to one.
 */
export type OpenedConversation = {
  threadId: ThreadId
  events: readonly Event[]
  turns: readonly TurnSpend[]
  name: string | null
  started: boolean
  model?: ThreadModel | undefined
  lost?: RecoveredAgents | undefined
}

export const unstartedConversation = (args: { ids: IdPort }): OpenedConversation => ({
  threadId: args.ids.nextThreadId(),
  events: [],
  turns: [],
  name: null,
  started: false,
})

export type OpenOutcome =
  { ok: true; conversation: OpenedConversation } | { ok: false; reason: string }

type Opening = {
  threads: ThreadStorePort
  log: EventLogPort
  ledger: TurnLedgerPort
  agents: AgentRegistryPort
  ids: IdPort
  workspace: WorkspaceIdentity
  open: OpenRequest
}

const unknownThread = (args: { threadId: string; project: string }): string =>
  `no conversation "${args.threadId}" has been opened in ${args.project}`

/**
 * A thread with no workspace of its own predates the attribution and belongs to whoever asks for it
 * by id; one attributed elsewhere in this project (the main checkout or any of its worktrees) is
 * resumable from anywhere in it. One attributed to another project stays where it is.
 */
const reachableFrom = (args: { thread: ThreadSummary; project: string }): boolean =>
  args.thread.workspace === null ||
  args.thread.workspace === args.project ||
  args.thread.repo === args.project

const namedBy = (args: { thread: ThreadSummary; handle: string }): boolean => {
  const { title } = args.thread
  if (title === undefined) return false

  const asked = args.handle.toLowerCase()
  return title.toLowerCase() === asked || slugOfTitle(title) === slugOfTitle(args.handle)
}

async function resumed(args: Opening & { handle: string }): Promise<ThreadSummary | undefined> {
  const { handle, threads, workspace } = args
  const project = projectOf(workspace)

  const byId = await threads.find({ threadId: toThreadId(handle) })
  if (byId !== undefined && reachableFrom({ thread: byId, project })) {
    if (byId.workspace === null) {
      await threads.adopt({
        threadId: byId.id,
        workspace: workspace.workspace,
        repo: workspace.repo,
      })
    }

    return byId
  }

  const listed = await threads.list({ project })
  return listed.find((thread) => namedBy({ thread, handle }))
}

type Found = ThreadSummary | { unstarted: true } | { reason: string }

async function threadFor(args: Opening): Promise<Found> {
  const { threads, workspace } = args
  const project = projectOf(workspace)
  const unstarted = { unstarted: true } as const

  if (args.open.mode === EOpenMode.New) return unstarted

  if (args.open.mode === EOpenMode.Continue) {
    return (await threads.mostRecent({ project })) ?? unstarted
  }

  const { threadId } = args.open
  const found = await resumed({ ...args, handle: threadId })
  if (found === undefined) {
    return { reason: unknownThread({ threadId, project }) }
  }

  return found
}

/**
 * The order is the invariant. Children the last process lost are settled before the transcript is
 * read, so the endings it writes are in the events the screen is built from rather than a turn
 * behind them; settling twice is safe, so an operator returning to a conversation costs nothing.
 */
export async function openConversation(args: Opening): Promise<OpenOutcome> {
  const thread = await threadFor(args)
  if ('reason' in thread) return { ok: false, reason: thread.reason }
  if ('unstarted' in thread) {
    return { ok: true, conversation: unstartedConversation({ ids: args.ids }) }
  }

  const lost = await args.agents.recordLostAgents({ threadId: thread.id })

  const [events, spent] = await Promise.all([
    args.log.read({ threadId: thread.id }),
    readThreadSpend({ ledger: args.ledger, threadId: thread.id }),
  ])

  return {
    ok: true,
    conversation: {
      threadId: thread.id,
      events,
      turns: spent.turns,
      name: thread.title ?? null,
      started: true,
      model: thread.model,
      lost,
    },
  }
}
