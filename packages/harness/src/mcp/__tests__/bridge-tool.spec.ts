import { describe, expect, it } from 'bun:test'

import {
  EToolEffect,
  toThreadId,
  type ToolInvocation,
} from '@dltech/atlas-core'

import { MAX_MODEL_TEXT_CHARACTERS, McpBridgeTool } from '../bridge/bridge-tool'
import type { McpToolInfo } from '../transport'
import { InMemoryTransport, toolInfo } from './fixture-transport'

const invocation = (): ToolInvocation => ({
  input: { path: 'a.ts' },
  signal: new AbortController().signal,
  idempotencyKey: 'key-1',
  projectDirectory: '/repo',
  threadId: toThreadId('thread-1'),
})

const bridgeOf = (args: { info: McpToolInfo; transport?: InMemoryTransport | undefined }): McpBridgeTool =>
  new McpBridgeTool({
    serverId: 'fs',
    info: args.info,
    transportOf: () => args.transport ?? new InMemoryTransport(),
  })

describe('McpBridgeTool naming', () => {
  it('joins the server and tool names exactly once', () => {
    const tool = bridgeOf({ info: toolInfo({ name: 'read' }) })

    expect(tool.name).toBe('mcp__fs__read')
    expect(tool.serverId).toBe('fs')
    expect(tool.toolName).toBe('read')
  })

  it('falls back to the joined name when the server gives no description', () => {
    const tool = bridgeOf({ info: toolInfo({ name: 'read' }) })
    expect(tool.description).toBe('mcp__fs__read')
  })
})

describe('McpBridgeTool schemas', () => {
  it('advertises a permissive zod record for dispatch while carrying the raw schema for the model', () => {
    const raw = { type: 'object', properties: { path: { type: 'string' } } }
    const tool = bridgeOf({ info: toolInfo({ name: 'read', inputSchema: raw }) })

    expect(tool.inputSchema).toBeDefined()
    expect(tool.jsonSchema).toEqual(raw)
  })
})

describe('McpBridgeTool effect and concurrency', () => {
  it('maps readOnlyHint to Read and concurrency-safe', () => {
    const tool = bridgeOf({ info: toolInfo({ name: 'read', annotations: { readOnlyHint: true } }) })

    expect(tool.effect).toBe(EToolEffect.Read)
    expect(tool.isConcurrencySafe?.({ anything: 'here' })).toBe(true)
  })

  it('maps destructiveHint to Destructive and not concurrency-safe', () => {
    const tool = bridgeOf({ info: toolInfo({ name: 'drop', annotations: { destructiveHint: true } }) })

    expect(tool.effect).toBe(EToolEffect.Destructive)
    expect(tool.isConcurrencySafe).toBeUndefined()
  })

  it('defaults to Write and not concurrency-safe without hints', () => {
    const tool = bridgeOf({ info: toolInfo({ name: 'touch' }) })

    expect(tool.effect).toBe(EToolEffect.Write)
    expect(tool.isConcurrencySafe).toBeUndefined()
  })

  it('ignores hint values that are not booleans', () => {
    const tool = bridgeOf({
      info: toolInfo({ name: 'read', annotations: { title: 'just a title' } }),
    })

    expect(tool.effect).toBe(EToolEffect.Write)
  })
})

describe('McpBridgeTool invocation', () => {
  it('calls the transport by the structural tool name with the parsed input', async () => {
    const transport = new InMemoryTransport()
    const tool = bridgeOf({ info: toolInfo({ name: 'read' }), transport })

    const outcome = await tool.invoke(invocation())

    expect(transport.calls).toEqual([{ name: 'read', input: { path: 'a.ts' } }])
    expect(outcome).toEqual({ ok: true, output: transport.response, modelText: 'ok' })
  })

  it('refuses when the lookup cannot produce a transport', async () => {
    const tool = new McpBridgeTool({
      serverId: 'fs',
      info: toolInfo({ name: 'read' }),
      transportOf: () => undefined,
    })

    const outcome = await tool.invoke(invocation())

    expect(outcome).toEqual({
      ok: false,
      reason: "the 'fs' MCP server is not connected",
    })
  })

  it('turns a throwing transport into an error outcome', async () => {
    const transport = new InMemoryTransport()
    transport.response = () => {
      throw new Error('boom')
    }
    const tool = bridgeOf({ info: toolInfo({ name: 'read' }), transport })

    const outcome = await tool.invoke(invocation())

    expect(outcome).toEqual({ ok: false, reason: "the 'fs' MCP server rejected the call: boom" })
  })

  it('renders isError content as an error reason', async () => {
    const transport = new InMemoryTransport()
    transport.response = { content: [{ type: 'text', text: 'permission denied' }], isError: true }
    const tool = bridgeOf({ info: toolInfo({ name: 'read' }), transport })

    const outcome = await tool.invoke(invocation())

    expect(outcome).toEqual({ ok: false, reason: 'permission denied' })
  })

  it('prefers structuredContent over block content', async () => {
    const transport = new InMemoryTransport()
    transport.response = {
      content: [{ type: 'text', text: 'rendered from blocks' }],
      structuredContent: { count: 42 },
    }
    const tool = bridgeOf({ info: toolInfo({ name: 'read' }), transport })

    const outcome = await tool.invoke(invocation())

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.output).toEqual({ count: 42 })
    expect(outcome.modelText).toBe(JSON.stringify({ count: 42 }))
  })

  it('puts an image block into modelParts as an ImagePart', async () => {
    const transport = new InMemoryTransport()
    transport.response = {
      content: [
        { type: 'text', text: 'covers' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
    }
    const tool = bridgeOf({ info: toolInfo({ name: 'read' }), transport })

    const outcome = await tool.invoke(invocation())

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.modelParts).toEqual([
      { type: 'text', text: 'covers' },
      { type: 'image', data: 'aW1hZ2U=', mediaType: 'image/png' },
    ])
  })

  it('appends a truncation note past the character cap', async () => {
    const transport = new InMemoryTransport()
    transport.response = { content: [{ type: 'text', text: 'x'.repeat(MAX_MODEL_TEXT_CHARACTERS + 10) }] }
    const tool = bridgeOf({ info: toolInfo({ name: 'read' }), transport })

    const outcome = await tool.invoke(invocation())

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.modelText).toContain('x'.repeat(MAX_MODEL_TEXT_CHARACTERS))
    expect(outcome.modelText).toContain('exceeded')
  })
})
