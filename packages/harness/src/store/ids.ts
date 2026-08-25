import { randomUUID } from 'node:crypto'

import {
  toBranchId,
  toCallId,
  toEventId,
  toRunId,
  type BranchId,
  type CallId,
  type EventId,
  type IdPort,
  type RunId,
} from '@dltech/atlas-core'

export class RandomIds implements IdPort {
  nextBranchId(): BranchId {
    return toBranchId(`brn_${randomUUID()}`)
  }

  nextRunId(): RunId {
    return toRunId(`run_${randomUUID()}`)
  }

  nextEventId(): EventId {
    return toEventId(`evt_${randomUUID()}`)
  }

  nextCallId(): CallId {
    return toCallId(`cal_${randomUUID()}`)
  }
}
