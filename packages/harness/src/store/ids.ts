import { randomUUID } from 'node:crypto'

import {
  toThreadId,
  toCallId,
  toEventId,
  toRunId,
  type ThreadId,
  type CallId,
  type EventId,
  type IdPort,
  type RunId,
} from '@dltech/atlas-core'

import { injectable } from '../container/injection'

@injectable()
export class RandomIds implements IdPort {
  nextThreadId(): ThreadId {
    return toThreadId(`brn_${randomUUID()}`)
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
