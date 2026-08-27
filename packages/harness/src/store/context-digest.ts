import { createHash } from 'node:crypto'

export const contextDigestOf = (content: string): string =>
  createHash('sha256').update(content).digest('hex')
