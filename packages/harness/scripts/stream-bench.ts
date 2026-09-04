#!/usr/bin/env bun
/**
 * Offline repro for the streaming CPU burn: a kimi-speed SSE stream (thousands of small deltas,
 * one large tool-call input streamed in 15-byte pieces) pushed through four paths — mock model
 * with/without streamText, and the real Anthropic provider over an in-memory SSE response,
 * with/without streamText. No network, no clock — parts are available immediately, so every
 * millisecond is library CPU.
 *
 * bun packages/harness/scripts/stream-bench.ts
 * bun --cpu-prof packages/harness/scripts/stream-bench.ts   # then read the .cpuprofile
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { stepCountIs, streamText } from 'ai'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'

const TEXT_DELTAS = 2_000
const TOOL_INPUT_BYTES = 60_000
const TOOL_DELTA_BYTES = 15

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 500, text: 500, reasoning: 0 },
}

function buildParts(): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
  ]
  for (let i = 0; i < TEXT_DELTAS; i += 1) {
    parts.push({ type: 'text-delta', id: 't1', delta: 'word ' })
  }
  parts.push({ type: 'text-end', id: 't1' })

  parts.push({ type: 'tool-input-start', id: 'call-1', toolName: 'write' })
  const piece = 'x'.repeat(TOOL_DELTA_BYTES)
  for (let sent = 0; sent < TOOL_INPUT_BYTES; sent += TOOL_DELTA_BYTES) {
    parts.push({ type: 'tool-input-delta', id: 'call-1', delta: piece })
  }
  parts.push({ type: 'tool-input-end', id: 'call-1' })
  parts.push({
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'write',
    input: JSON.stringify({ path: '/tmp/out', content: 'x'.repeat(TOOL_INPUT_BYTES) }),
  })
  parts.push({
    type: 'finish',
    usage,
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
  })
  return parts
}

const totalParts = TEXT_DELTAS + TOOL_INPUT_BYTES / TOOL_DELTA_BYTES + 6

function mockModel(): MockLanguageModelV4 {
  const parts = buildParts()
  return new MockLanguageModelV4({
    doStream: () => {
      let index = 0
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          pull(controller) {
            if (index >= parts.length) {
              controller.close()
              return
            }
            controller.enqueue(parts[index])
            index += 1
          },
        }),
      })
    },
  })
}

type Run = { wallMs: number; cpuMs: number; parts: number }

async function viaStreamText(): Promise<Run> {
  const cpu = process.cpuUsage()
  const started = performance.now()
  let parts = 0

  const stream = streamText({
    model: mockModel(),
    messages: [{ role: 'user', content: 'write the file' }],
    stopWhen: stepCountIs(1),
    maxRetries: 0,
    onError: () => undefined,
  })
  for await (const part of stream.fullStream) {
    void part
    parts += 1
  }

  const used = process.cpuUsage(cpu)
  return { wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, parts }
}

async function viaDoStream(): Promise<Run> {
  const cpu = process.cpuUsage()
  const started = performance.now()
  let parts = 0

  const result = await mockModel().doStream({
    prompt: [],
  } as Parameters<MockLanguageModelV4['doStream']>[0])
  for await (const part of result.stream) {
    void part
    parts += 1
  }

  const used = process.cpuUsage(cpu)
  return { wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, parts }
}

const report = (name: string, runs: Run[]): void => {
  const cpu = runs.map((run) => run.cpuMs)
  const best = Math.min(...cpu)
  console.log(
    `${name.padEnd(22)} cpu ms: ${cpu.map((ms) => ms.toFixed(0).padStart(6)).join(' ')}  → best ${best.toFixed(0)} ms, ${(best / totalParts).toFixed(3)} ms/part over ${totalParts} parts`,
  )
}

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function anthropicSseStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const events: string[] = [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_bench',
        type: 'message',
        role: 'assistant',
        model: 'bench',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    }),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  ]
  for (let i = 0; i < TEXT_DELTAS; i += 1) {
    events.push(
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'word ' },
      }),
    )
  }
  events.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  events.push(
    sse('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_bench', name: 'write', input: {} },
    }),
  )
  const piece = 'x'.repeat(TOOL_DELTA_BYTES)
  for (let sent = 0; sent < TOOL_INPUT_BYTES; sent += TOOL_DELTA_BYTES) {
    events.push(
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: piece },
      }),
    )
  }
  events.push(sse('content_block_stop', { type: 'content_block_stop', index: 1 }))
  events.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 500 },
    }),
  )
  events.push(sse('message_stop', { type: 'message_stop' }))

  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= events.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(events[index]))
      index += 1
    },
  })
}

function anthropicModel() {
  return createAnthropic({
    apiKey: 'bench-key',
    fetch: (() =>
      Promise.resolve(
        new Response(anthropicSseStream(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      )) as unknown as typeof fetch,
  })('claude-haiku-4-5')
}

const BENCH_PROMPT = {
  prompt: [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'write the file' }],
    },
  ],
}

async function viaAnthropicStreamText(): Promise<Run> {
  const cpu = process.cpuUsage()
  const started = performance.now()
  let parts = 0

  const stream = streamText({
    model: anthropicModel(),
    messages: [{ role: 'user', content: 'write the file' }],
    stopWhen: stepCountIs(1),
    maxRetries: 0,
    onError: () => undefined,
  })
  for await (const part of stream.fullStream) {
    void part
    parts += 1
  }

  const used = process.cpuUsage(cpu)
  return { wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, parts }
}

async function viaAnthropicDoStream(): Promise<Run> {
  const cpu = process.cpuUsage()
  const started = performance.now()
  let parts = 0

  const result = await anthropicModel().doStream(BENCH_PROMPT)
  for await (const part of result.stream) {
    void part
    parts += 1
  }

  const used = process.cpuUsage(cpu)
  return { wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, parts }
}

function openAiSseStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunk = (delta: unknown, finishReason?: string): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-bench',
      object: 'chat.completion.chunk',
      created: 1_757_000_000,
      model: 'kimi-k3-fast',
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    })}\n\n`

  const events: string[] = []
  for (let i = 0; i < TEXT_DELTAS; i += 1) {
    events.push(chunk({ content: 'word ' }))
  }
  events.push(
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_bench',
          type: 'function',
          function: { name: 'write', arguments: '' },
        },
      ],
    }),
  )
  const piece = 'x'.repeat(TOOL_DELTA_BYTES)
  for (let sent = 0; sent < TOOL_INPUT_BYTES; sent += TOOL_DELTA_BYTES) {
    events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
  }
  events.push(chunk({}, 'tool_calls'))
  events.push('data: [DONE]\n\n')

  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= events.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(events[index]))
      index += 1
    },
  })
}

function openAiModel() {
  return createOpenAICompatible({
    name: 'inference',
    apiKey: 'bench-key',
    baseURL: 'http://bench.local/v1',
    fetch: (() =>
      Promise.resolve(
        new Response(openAiSseStream(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      )) as unknown as typeof fetch,
  })('kimi-k3-fast')
}

async function viaOpenAiStreamText(): Promise<Run> {
  const cpu = process.cpuUsage()
  const started = performance.now()
  let parts = 0

  const stream = streamText({
    model: openAiModel(),
    messages: [{ role: 'user', content: 'write the file' }],
    stopWhen: stepCountIs(1),
    maxRetries: 0,
    onError: () => undefined,
  })
  for await (const part of stream.fullStream) {
    void part
    parts += 1
  }

  const used = process.cpuUsage(cpu)
  return { wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, parts }
}

async function viaOpenAiDoStream(): Promise<Run> {
  const cpu = process.cpuUsage()
  const started = performance.now()
  let parts = 0

  const result = await openAiModel().doStream(BENCH_PROMPT)
  for await (const part of result.stream) {
    void part
    parts += 1
  }

  const used = process.cpuUsage(cpu)
  return { wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, parts }
}

await viaStreamText()
await viaDoStream()
await viaAnthropicStreamText()
await viaAnthropicDoStream()
await viaOpenAiStreamText()
await viaOpenAiDoStream()

const paths: [string, () => Promise<Run>][] = [
  ['mock+streamText', viaStreamText],
  ['mock+doStream', viaDoStream],
  ['anthropic+streamText', viaAnthropicStreamText],
  ['anthropic+doStream', viaAnthropicDoStream],
  ['openai+streamText', viaOpenAiStreamText],
  ['openai+doStream', viaOpenAiDoStream],
]
const results = new Map<string, Run[]>()
for (const [name] of paths) results.set(name, [])
for (let round = 0; round < 3; round += 1) {
  for (const [name, run] of paths) results.get(name)!.push(await run())
}
for (const [name] of paths) report(name, results.get(name)!)
