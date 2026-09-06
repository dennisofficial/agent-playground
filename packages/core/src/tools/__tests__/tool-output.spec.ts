import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { toThreadId } from '../../events/ids'
import {
  EToolEffect,
  SchemaTool,
  type OnToolOutput,
  type ToolOutcome,
  type ToolRun,
} from '../tool'

const schema = z.strictObject({ path: z.string() })

class TappingTool extends SchemaTool<typeof schema> {
  readonly name = 'tap'
  readonly description = 'the tap tool'
  readonly effect = EToolEffect.Read
  readonly inputSchema = schema
  readonly pathFields = [] as const

  seen: OnToolOutput | undefined

  protected async run(args: ToolRun<typeof schema>): Promise<ToolOutcome> {
    this.seen = args.onOutput
    args.onOutput?.({ stream: 'stdout', text: 'half\n' })
    return { ok: true, output: 'done', modelText: 'done' }
  }
}

const invocation = (onOutput?: OnToolOutput) => ({
  input: { path: 'a.ts' },
  signal: new AbortController().signal,
  idempotencyKey: 'run-1:call-1',
  projectDirectory: '/workspace',
  threadId: toThreadId('thread-1'),
  ...(onOutput === undefined ? {} : { onOutput }),
})

describe('a schema tool invoked with an output listener', () => {
  it('hands the listener through to the run, chunks tagged by stream', async () => {
    const tool = new TappingTool()
    const chunks: { stream: string; text: string }[] = []

    const outcome = await tool.invoke(invocation((chunk) => chunks.push(chunk)))

    expect(outcome).toEqual({ ok: true, output: 'done', modelText: 'done' })
    expect(chunks).toEqual([{ stream: 'stdout', text: 'half\n' }])
  })

  it('runs unchanged when the invocation carries none', async () => {
    const tool = new TappingTool()

    const outcome = await tool.invoke(invocation())

    expect(outcome).toEqual({ ok: true, output: 'done', modelText: 'done' })
    expect(tool.seen).toBeUndefined()
  })
})
