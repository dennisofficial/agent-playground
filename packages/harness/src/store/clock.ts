import type { ClockPort } from '@dltech/atlas-core'

import { injectable } from '../container/injection'

@injectable()
export class SystemClock implements ClockPort {
  now(): string {
    return new Date().toISOString()
  }
}
