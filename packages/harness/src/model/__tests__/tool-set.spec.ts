import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { EToolEffect, type ToolDeclaration } from '@dltech/atlas-core'

import { toToolSet } from '../tool-set'

const zodDeclaration: ToolDeclaration = {
  name: 'read',
  description: 'Read a file',
  effect: EToolEffect.Read,
  inputSchema: z.strictObject({ path: z.string() }),
}

const mcpDeclaration: ToolDeclaration = {
  name: 'mcp_lookup',
  description: 'An MCP tool carrying the server schema',
  effect: EToolEffect.Read,
  inputSchema: z.record(z.string(), z.unknown()),
  jsonSchema: { type: 'object', properties: { query: { type: 'string' } } },
}

describe('toToolSet', () => {
  it('pins strict: false on every tool, whether the schema is zod or a raw MCP schema', () => {
    const tools = toToolSet([zodDeclaration, mcpDeclaration])

    expect(tools['read']?.strict).toBe(false)
    expect(tools['mcp_lookup']?.strict).toBe(false)
  })
})
