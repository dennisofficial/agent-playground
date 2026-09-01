import type { ERiskDimension } from './dimension'

export enum EGrantScope {
  Thread = 'thread',
}

export type Grant = {
  grantId: string
  dimensions: readonly ERiskDimension[]
  scope: EGrantScope
  subject: string
  reason: string
  seq: number
}
