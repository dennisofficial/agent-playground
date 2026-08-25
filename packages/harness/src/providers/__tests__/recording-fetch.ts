import type { AnthropicFetch } from '../anthropic-oauth'

type FetchHandler = (
  input: Parameters<AnthropicFetch>[0],
  init: Parameters<AnthropicFetch>[1],
) => Promise<Response>

const withPreconnect = (handler: FetchHandler): AnthropicFetch =>
  Object.assign(handler, { preconnect: globalThis.fetch.preconnect })

export type RecordedRequest = { url: string; headers: Headers; body: unknown }
export type RecordedRequestBody = { url: string; body: unknown }

export type RecordingFetch = {
  fetch: AnthropicFetch
  requests: readonly RecordedRequest[]
}

export type BodyOnlyRecordingFetch = {
  fetch: AnthropicFetch
  requests: readonly RecordedRequestBody[]
}

const sse = (events: readonly Record<string, unknown>[]): string =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')

export const streamedText = (text: string): string =>
  sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'stub',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ])

const parsedBody = (body: unknown): unknown => {
  if (typeof body !== 'string') return undefined
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function recordingFetch(args: { body: string }): RecordingFetch {
  const requests: RecordedRequest[] = []

  return {
    requests,
    fetch: withPreconnect(async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: parsedBody(init?.body),
      })

      return new Response(args.body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }),
  }
}

export function bodyOnlyRecordingPassthroughFetch(): BodyOnlyRecordingFetch {
  const requests: RecordedRequestBody[] = []

  return {
    requests,
    fetch: withPreconnect((input, init) => {
      requests.push({ url: String(input), body: parsedBody(init?.body) })
      return globalThis.fetch(input, init)
    }),
  }
}
