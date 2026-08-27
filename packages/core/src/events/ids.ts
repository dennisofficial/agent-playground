import { z } from 'zod'

const identifier = z.string().min(1)

export const threadIdSchema = identifier.brand<'ThreadId'>()
export const runIdSchema = identifier.brand<'RunId'>()
export const eventIdSchema = identifier.brand<'EventId'>()
export const callIdSchema = identifier.brand<'CallId'>()
export const snapshotIdSchema = identifier.brand<'SnapshotId'>()

export type ThreadId = z.infer<typeof threadIdSchema>
export type RunId = z.infer<typeof runIdSchema>
export type EventId = z.infer<typeof eventIdSchema>
export type CallId = z.infer<typeof callIdSchema>
export type SnapshotId = z.infer<typeof snapshotIdSchema>

export const toThreadId = (value: string): ThreadId => threadIdSchema.parse(value)
export const toRunId = (value: string): RunId => runIdSchema.parse(value)
export const toEventId = (value: string): EventId => eventIdSchema.parse(value)
export const toCallId = (value: string): CallId => callIdSchema.parse(value)
export const toSnapshotId = (value: string): SnapshotId => snapshotIdSchema.parse(value)
