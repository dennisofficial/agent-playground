import { describe, expect, it } from 'bun:test'

import { log } from '../../assembly/__tests__/log-fixture'
import { summarizeWarpPermission, warpStopTexts } from '../extract'

describe('warpStopTexts', () => {
  it('is undefined when the assistant never spoke', () => {
    expect(warpStopTexts({ events: log([{ type: 'user-said', text: 'hello' }]) })).toBeUndefined()
  })

  it('takes the last user prompt and the last assistant text', () => {
    const events = log([
      { type: 'user-said', text: 'first' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'answer one' }] },
      { type: 'user-said', text: 'second' },
      {
        type: 'assistant-said',
        parts: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'answer two' },
        ],
      },
    ])

    expect(warpStopTexts({ events })).toEqual({ query: 'second', response: 'answer two' })
  })

  it('joins multiple text parts with a space', () => {
    const events = log([
      { type: 'user-said', text: 'go' },
      {
        type: 'assistant-said',
        parts: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
        ],
      },
    ])

    expect(warpStopTexts({ events })?.response).toBe('part one part two')
  })

  it('reports an empty query when the turn had no user prompt', () => {
    const events = log([{ type: 'assistant-said', parts: [{ type: 'text', text: 'done' }] }])

    expect(warpStopTexts({ events })).toEqual({ query: '', response: 'done' })
  })
})

describe('summarizeWarpPermission', () => {
  it('prefers the command from the tool input', () => {
    expect(
      summarizeWarpPermission({ toolName: 'bash', toolInput: { command: 'bun test' } }),
    ).toBe('Wants to run bash: bun test')
  })

  it('falls back to the file path', () => {
    expect(
      summarizeWarpPermission({ toolName: 'edit', toolInput: { file_path: '/tmp/x.ts' } }),
    ).toBe('Wants to run edit: /tmp/x.ts')
  })

  it('falls back to a truncated JSON preview', () => {
    const input = { url: 'https://example.com/' + 'a'.repeat(200) }
    const summary = summarizeWarpPermission({ toolName: 'web_fetch', toolInput: input })
    expect(summary.startsWith('Wants to run web_fetch: {"url":"https://example.com/')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual('Wants to run web_fetch: '.length + 120)
  })

  it('omits the preview when the input is not an object', () => {
    expect(summarizeWarpPermission({ toolName: 'bash', toolInput: undefined })).toBe(
      'Wants to run bash',
    )
  })

  it('truncates a long command to a 120-char preview', () => {
    const summary = summarizeWarpPermission({
      toolName: 'bash',
      toolInput: { command: 'c'.repeat(300) },
    })
    expect(summary).toBe(`Wants to run bash: ${'c'.repeat(117)}...`)
  })
})
