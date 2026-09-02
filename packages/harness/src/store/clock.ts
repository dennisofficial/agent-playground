import type { ClockPort } from '@dltech/atlas-core'


export class SystemClock implements ClockPort {
  now(): string {
    return new Date().toISOString()
  }
}
