import { describe, expect, it } from 'bun:test'

import {
  EFinishReason,
  toEventId,
  type Assembled,
  type Chunk,
  type ProviderIdentity,
  type ProviderPrompt,
} from '@dltech/atlas-core'

import { AiSdkModelPort, runModelStream } from '../ai-sdk-model-port'
import type { RawTape } from '../raw-tape'
import { scriptedModel, type ScriptedStep } from '../testing/scripted-model'

class RecordingTape implements RawTape {
  readonly parts: unknown[] = []
  closes = 0

  tap = (part: unknown): void => {
    this.parts.push(part)
  }

  close = async (): Promise<void> => {
    this.closes += 1
  }
}

const typeOf = (part: unknown): string => {
  if (typeof part !== 'object' || part === null || !('type' in part)) return ''
  const { type } = part
  return typeof type === 'string' ? type : ''
}

const identity: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }

const prompt: ProviderPrompt = {
  instructions: [{ text: 'You are Atlas.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'what changed?' }] }],
  provider: identity,
}

const assembled: Assembled = {
  system: [{ text: 'You are Atlas.' }],
  messages: [
    {
      message: { role: 'user', content: [{ type: 'text', text: 'what changed?' }] },
      origin: { eventId: toEventId('evt-1'), seq: 1 },
    },
  ],
}

const oneTurn: ScriptedStep = { reasoning: { text: 'checking the diff' }, text: 'two files' }

const runStream = (args: { tape?: RawTape; chunks?: Chunk[] }) =>
  runModelStream({
    model: scriptedModel({ script: [oneTurn] }),
    prompt,
    tools: [],
    signal: new AbortController().signal,
    ...(args.tape === undefined ? {} : { tape: args.tape }),
    ...(args.chunks === undefined
      ? {}
      : {
          onChunk: (chunk: Chunk) => {
            args.chunks?.push(chunk)
            return chunk
          },
        }),
  })

describe('runModelStream tapping', () => {
  it('hands the tape every raw part the model streamed, in order', async () => {
    const tape = new RecordingTape()

    await runStream({ tape })

    expect(tape.parts.map(typeOf)).toEqual([
      'start',
      'start-step',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ])
  })

  it('hands the tape the raw part, not the converted chunk', async () => {
    const tape = new RecordingTape()

    await runStream({ tape })

    const delta = tape.parts.find((part) => typeOf(part) === 'text-delta')
    expect(delta).toEqual({ type: 'text-delta', id: 'scripted-text', text: 'two files' })
  })

  it('tapes a part that the conversion drops, so the tap must sit above it', async () => {
    const tape = new RecordingTape()
    const chunks: Chunk[] = []

    await runStream({ tape, chunks })

    const taped = tape.parts.map(typeOf)
    const converted = chunks.map((chunk) => chunk.type)

    for (const dropped of ['start', 'start-step', 'finish-step']) {
      expect(taped).toContain(dropped)
      expect(converted).not.toContain(dropped)
    }
    expect(tape.parts.length).toBeGreaterThan(chunks.length)
  })

  it('leaves the tape open — the stream does not own its lifetime', async () => {
    const tape = new RecordingTape()

    await runStream({ tape })
    const tapedDuringTheTurn = tape.parts.length
    tape.tap({ type: 'after-the-turn' })

    expect(tape.closes).toBe(0)
    expect(tape.parts.length).toBe(tapedDuringTheTurn + 1)
    expect(typeOf(tape.parts.at(-1))).toBe('after-the-turn')
  })

  it('taps across a second turn on the same tape', async () => {
    const tape = new RecordingTape()

    await runStream({ tape })
    const afterFirst = tape.parts.length
    await runStream({ tape })

    expect(afterFirst).toBeGreaterThan(0)
    expect(tape.parts.length).toBe(afterFirst * 2)
  })

  it('runs with no tape at all', async () => {
    const result = await runStream({})

    expect(result.finishReason).toBe(EFinishReason.Stop)
    expect(result.parts).toEqual([
      { type: 'reasoning', text: 'checking the diff' },
      { type: 'text', text: 'two files' },
    ])
  })

  it('reaches the same result whether or not a tape is listening', async () => {
    const taped = await runStream({ tape: new RecordingTape() })
    const untaped = await runStream({})

    expect(taped).toEqual(untaped)
  })
})

describe('AiSdkModelPort tapping', () => {
  const stepWith = (tape?: RawTape) =>
    new AiSdkModelPort({
      model: scriptedModel({ script: [oneTurn] }),
      identity,
      ...(tape === undefined ? {} : { tape }),
    }).step({ assembled, tools: [], signal: new AbortController().signal })

  it('forwards the tape it was built with down into the stream', async () => {
    const tape = new RecordingTape()

    await stepWith(tape)

    expect(tape.parts.map(typeOf)).toContain('text-delta')
    expect(tape.closes).toBe(0)
  })

  it('steps without a tape', async () => {
    const result = await stepWith()

    expect(result.finishReason).toBe(EFinishReason.Stop)
  })
})
