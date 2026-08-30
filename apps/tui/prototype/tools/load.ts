// PROTOTYPE — throwaway. Reads a real thread out of the Atlas sqlite store so the tool-call
// variants are judged against real transcripts rather than invented fixtures.

import { Database } from 'bun:sqlite'

import type { Event } from '@dltech/atlas-core'
import { atlasDatabaseFile, decodeEventRows } from '@dltech/atlas-harness'

type EventRow = {
  id: string
  threadId: string
  seq: number
  runId: string
  parentRunId: string | null
  depth: number
  at: string
  type: string
  body: string
  contextSlot: string | null
  contextKey: string | null
  contextDigest: string | null
}

export type ThreadRow = { id: string; title: string | null; events: number; tools: number }

const DEFAULT_DB = atlasDatabaseFile()

export const databasePath = (argv: readonly string[]): string =>
  argv.find((arg) => arg.startsWith('--db='))?.slice('--db='.length) ?? DEFAULT_DB

export function threadsIn(path: string): ThreadRow[] {
  const database = new Database(path, { readonly: true })
  const rows = database
    .query<ThreadRow, []>(
      `select t.id as id,
              t.title as title,
              count(e.id) as events,
              sum(case when e.type = 'tool-called' then 1 else 0 end) as tools
         from Thread t
         join Event e on e.threadId = t.id
        group by t.id
        order by tools desc, events desc`,
    )
    .all()
  database.close()
  return rows
}

export type LoadedThread = { thread: ThreadRow; events: readonly Event[]; unreadable: number }

export function loadThread(args: { path: string; threadId?: string | undefined }): LoadedThread {
  const threads = threadsIn(args.path)
  const thread =
    args.threadId === undefined
      ? threads[0]
      : threads.find((candidate) => candidate.id === args.threadId)

  if (thread === undefined) throw new Error(`no thread to render in ${args.path}`)

  const database = new Database(args.path, { readonly: true })
  const rows = database
    .query<EventRow, [string]>(
      `select id, threadId, seq, runId, parentRunId, depth, at, type, body,
              contextSlot, contextKey, contextDigest
         from Event where threadId = ? order by seq`,
    )
    .all(thread.id)
  database.close()

  const decoded = decodeEventRows(rows)
  return { thread, events: decoded.events, unreadable: decoded.unreadable.length }
}
