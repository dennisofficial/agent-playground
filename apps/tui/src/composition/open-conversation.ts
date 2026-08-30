import {
  toThreadId,
  type ThreadId,
  type Event,
  type EventLogPort,
  type WorkspaceIdentity,
} from '@dltech/atlas-core'
import type {
  ThreadStorePort,
  ThreadSummary,
  TurnLedgerPort,
  TurnSpend,
} from '@dltech/atlas-harness'

import { EOpenMode, type OpenRequest } from './config'
import { slugOfTitle } from './thread-slug'

export type OpenedConversation = {
  threadId: ThreadId
  events: readonly Event[]
  turns: readonly TurnSpend[]
  name: string | null
}

export type OpenOutcome =
  { ok: true; conversation: OpenedConversation } | { ok: false; reason: string }

type Opening = {
  threads: ThreadStorePort
  log: EventLogPort
  ledger: TurnLedgerPort
  workspace: WorkspaceIdentity
  open: OpenRequest
}

const unknownThread = (args: { threadId: string; workspace: string }): string =>
  `no conversation "${args.threadId}" has been opened in ${args.workspace}`

/**
 * A thread with no workspace of its own predates the attribution and belongs to whoever asks for it
 * by id; one attributed elsewhere stays where it is.
 */
const reachableFrom = (args: { thread: ThreadSummary; workspace: string }): boolean =>
  args.thread.workspace === null || args.thread.workspace === args.workspace

const namedBy = (args: { thread: ThreadSummary; handle: string }): boolean => {
  const { title } = args.thread
  if (title === undefined) return false

  const asked = args.handle.toLowerCase()
  return title.toLowerCase() === asked || slugOfTitle(title) === slugOfTitle(args.handle)
}

async function resumed(args: Opening & { handle: string }): Promise<ThreadSummary | undefined> {
  const { handle, threads, workspace } = args

  const byId = await threads.find({ threadId: toThreadId(handle) })
  if (byId !== undefined && reachableFrom({ thread: byId, workspace: workspace.workspace })) {
    if (byId.workspace === null) {
      await threads.adopt({
        threadId: byId.id,
        workspace: workspace.workspace,
        repo: workspace.repo,
      })
    }

    return byId
  }

  const listed = await threads.list({ workspace: workspace.workspace })
  return listed.find((thread) => namedBy({ thread, handle }))
}

async function threadFor(args: Opening): Promise<ThreadSummary | { reason: string }> {
  const { threads, workspace } = args
  const fresh = () => threads.create({ workspace: workspace.workspace, repo: workspace.repo })

  if (args.open.mode === EOpenMode.New) return fresh()

  if (args.open.mode === EOpenMode.Continue) {
    return (await threads.mostRecent({ workspace: workspace.workspace })) ?? (await fresh())
  }

  const { threadId } = args.open
  const found = await resumed({ ...args, handle: threadId })
  if (found === undefined) {
    return { reason: unknownThread({ threadId, workspace: workspace.workspace }) }
  }

  return found
}

export async function openConversation(args: Opening): Promise<OpenOutcome> {
  const thread = await threadFor(args)
  if ('reason' in thread) return { ok: false, reason: thread.reason }

  const [events, turns] = await Promise.all([
    args.log.read({ threadId: thread.id }),
    args.ledger.forThread({ threadId: thread.id }),
  ])

  return {
    ok: true,
    conversation: {
      threadId: thread.id,
      events,
      turns,
      name: thread.title ?? null,
    },
  }
}
