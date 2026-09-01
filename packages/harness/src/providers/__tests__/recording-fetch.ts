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

export const generatedText = (text: string): string =>
  JSON.stringify({
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })

const parsedBody = (body: unknown): unknown => {
  if (typeof body !== 'string') return undefined
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function recordingFetch(args: { body: string; contentType?: string }): RecordingFetch {
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
        headers: { 'content-type': args.contentType ?? 'text/event-stream' },
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

export const REVOKED_TOKEN_BODY = JSON.stringify({
  type: 'error',
  error: { type: 'authentication_error', message: 'OAuth access token has been revoked.' },
})

export function refusingFirstFetch(args: {
  body: string
  status?: number
  contentType?: string
}): RecordingFetch {
  const requests: RecordedRequest[] = []

  return {
    requests,
    fetch: withPreconnect(async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: parsedBody(init?.body),
      })

      if (requests.length === 1)
        return new Response(REVOKED_TOKEN_BODY, {
          status: args.status ?? 401,
          headers: { 'content-type': 'application/json' },
        })

      return new Response(args.body, {
        status: 200,
        headers: { 'content-type': args.contentType ?? 'text/event-stream' },
      })
    }),
  }
}
