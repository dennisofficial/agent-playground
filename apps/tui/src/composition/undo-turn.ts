import type { ThreadId, Event, EventLogPort } from '@dltech/atlas-core'
import { rewindThread, type ThreadStorePort } from '@dltech/atlas-harness'

export enum EUndo {
  Restored = 'restored',
  Refused = 'refused',
  Nothing = 'nothing',
}

export type Undo =
  | { type: EUndo.Restored; text: string }
  | { type: EUndo.Refused; reason: string }
  | { type: EUndo.Nothing }

type Said = Extract<Event, { type: 'user-said' }>

const wasSaid = (event: Event): event is Said => event.type === 'user-said'

export async function undoTurn(args: {
  log: EventLogPort
  threads: ThreadStorePort
  threadId: ThreadId
}): Promise<Undo> {
  const { log, threads, threadId } = args

  const said = (await log.readOwn({ threadId })).findLast(wasSaid)
  if (said === undefined) return { type: EUndo.Nothing }

  const rewound = await rewindThread({ log, threads, threadId, toSeq: said.seq - 1 })
  if (!rewound.ok) return { type: EUndo.Refused, reason: rewound.reason }

  return { type: EUndo.Restored, text: said.text }
}
