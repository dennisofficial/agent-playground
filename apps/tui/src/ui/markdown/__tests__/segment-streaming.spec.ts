import { describe, expect, it } from 'bun:test'

import { growingSegments, segmentMarkdown } from '../segment'

const DOCUMENT = [
  '## Rebalance report',
  '',
  'The worker drifted past its quota while the queue kept growing.',
  'A second sentence with `inline code` and a [link](https://example.com).',
  '',
  '| queue | depth |',
  '| ----- | ----- |',
  '| main  | 12    |',
  '',
  '```ts queue.ts',
  'export const rebalance = (args: { queue: readonly Job[] }): readonly Job[] => {',
  '  const heavy = args.queue.filter((job) => job.cost > QUEUE_BUDGET)',
  '',
  '  const light = args.queue.filter((job) => job.cost <= QUEUE_BUDGET)',
  '  return [...heavy, ...light]',
  '}',
  '```',
  '',
  'Trailing prose after the fence.',
  '',
  '~~~text',
  'a tilde fence',
  '~~~',
  '',
].join('\n')

const cutPoints = (source: string): readonly string[] => {
  const cuts: string[] = []
  let offset = 0
  for (const line of source.split('\n')) {
    cuts.push(source.slice(0, offset + Math.floor(line.length / 2)))
    offset += line.length + 1
    cuts.push(source.slice(0, offset))
  }
  return cuts
}

describe('growingSegments while a stream is mid-flight', () => {
  it('answers exactly what a full re-lex would, at every cut point', () => {
    for (const prefix of cutPoints(DOCUMENT)) {
      expect(growingSegments({ source: prefix })).toEqual(segmentMarkdown(prefix))
    }
  })

  it('answers the same when the fence never closes', () => {
    const open = DOCUMENT.slice(0, DOCUMENT.indexOf('Trailing prose'))
    for (const prefix of cutPoints(open)) {
      expect(growingSegments({ source: prefix })).toEqual(segmentMarkdown(prefix))
    }
  })
})
