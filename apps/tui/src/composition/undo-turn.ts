import type { BranchId, Event, EventLogPort } from '@dltech/atlas-core'
import { rewindBranch, type BranchStorePort } from '@dltech/atlas-harness'

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
  branches: BranchStorePort
  branchId: BranchId
}): Promise<Undo> {
  const { log, branches, branchId } = args

  const said = (await log.readOwn({ branchId })).findLast(wasSaid)
  if (said === undefined) return { type: EUndo.Nothing }

  const rewound = await rewindBranch({ log, branches, branchId, toSeq: said.seq - 1 })
  if (!rewound.ok) return { type: EUndo.Refused, reason: rewound.reason }

  return { type: EUndo.Restored, text: said.text }
}
