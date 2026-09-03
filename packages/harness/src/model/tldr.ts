import { ETldrStatus, transcriptOfRange, type Event } from '@dltech/atlas-core'
import { streamObject, type LanguageModel } from 'ai'
import { z } from 'zod'

const TLDR_INSTRUCTION = [
  'You write the tl;dr footer for one turn of a coding-agent session between Operator and Atlas.',
  'The transcript runs from the operator\u2019s latest message to the end of the turn.',
  'Summarize what Atlas did or found, in one or two short lines, past tense.',
  'Answer what became of the operator\u2019s ask — if the asked-for thing is not done yet, say that',
  'plainly rather than only listing what happened instead.',
  'Report only what the transcript shows done; a plan, proposal or offered next step is not done.',
  'Announced intent is not a result: task lists and "starting X now" say what Atlas meant to do,',
  'and only a tool call that made the change counts as done.',
  'grep, read and ls change nothing — a turn of only those found things; it did not change things.',
  'Judge the turn by its last rows — if something it waited on arrived, the wait is over.',
  'If the turn repeats an action (a second walk, a re-run), the later pass is the outcome and',
  'the earlier pass\u2019s findings are superseded.',
  'If the transcript ends on tool calls or results with no closing word from Atlas, the turn',
  'ended mid-work: say what it was doing, never the planned end state.',
  'Say the outcome, not the itinerary — never enumerate more than two paths or symbols.',
  'Name exact paths, symbols and outcomes — never invent them.',
  'The status says how the turn ended:',
  '- "done": the operator\u2019s ask is answered, the requested work complete;',
  '- "needs-operator": the turn ended on a question, a plan or a decision for the operator —',
  'their reply is the next move;',
  '- "waiting": the turn handed off to background work (a background shell, a sub-agent) that',
  'will wake Atlas — the operator need not act.',
  'When both could hold — background work still running and something asked of the operator —',
  'choose "needs-operator": the wake will arrive on its own, but an unanswered ask sits with',
  'the operator forever.',
].join(' ')

const tldrSchema = z.object({
  status: z.enum(ETldrStatus),
  summary: z.string(),
})

export type TldrResult = { text: string; status: ETldrStatus }

const TURN_CHARACTER_LIMIT = 200_000
const TURN_PAYLOAD_CHARACTER_LIMIT = 4_000
const TLDR_OUTPUT_TOKEN_LIMIT = 260

export function tldrPrompt({
  events,
  anchorSeq,
  throughSeq,
}: {
  events: readonly Event[]
  anchorSeq: number
  throughSeq: number
}): string | null {
  const turn = transcriptOfRange({
    events,
    fromSeq: anchorSeq,
    throughSeq,
    payloadLimit: TURN_PAYLOAD_CHARACTER_LIMIT,
  }).trim()
  if (turn.length === 0) return null

  return turn.slice(-TURN_CHARACTER_LIMIT)
}

export async function tldrFor(args: {
  model: LanguageModel
  events: readonly Event[]
  anchorSeq: number
  throughSeq: number
  signal?: AbortSignal | undefined
  onChunk?: ((text: string) => void) | undefined
}): Promise<TldrResult | null> {
  const prompt = tldrPrompt({
    events: args.events,
    anchorSeq: args.anchorSeq,
    throughSeq: args.throughSeq,
  })
  if (prompt === null) return null

  try {
    const stream = streamObject({
      model: args.model,
      schema: tldrSchema,
      system: TLDR_INSTRUCTION,
      prompt,
      maxOutputTokens: TLDR_OUTPUT_TOKEN_LIMIT,
      onError: () => undefined,
      ...(args.signal === undefined ? {} : { abortSignal: args.signal }),
    })

    for await (const partial of stream.partialObjectStream) {
      if (typeof partial.summary === 'string') args.onChunk?.(partial.summary)
    }

    const result = await stream.object
    const text = result.summary.trim()
    return text.length === 0 ? null : { text, status: result.status }
  } catch {
    return null
  }
}
