import { z } from 'zod'

const shellIdSchema = z.string().min(1).brand<'ShellId'>()

export type ShellId = z.infer<typeof shellIdSchema>

export const toShellId = (value: string): ShellId => shellIdSchema.parse(value)
