import { describe, expect, it } from 'bun:test'
import { asSchema } from 'ai'

import { EToolEffect, type ToolDeclaration } from '@dltech/atlas-core'
import { z } from 'zod'

import { toToolSet } from '../../model/tool-set'

const declarationOf = (args: {
  name: string
  jsonSchema?: unknown
}): ToolDeclaration => ({
  name: args.name,
  description: `the ${args.name} tool`,
  effect: EToolEffect.Write,
  inputSchema: z.object({ path: z.string() }),
  ...(args.jsonSchema === undefined ? {} : { jsonSchema: args.jsonSchema }),
})

const publishedJson = (declaration: ToolDeclaration): unknown => {
  const held = toToolSet([declaration])[declaration.name]
  if (held === undefined) throw new Error(`tool '${declaration.name}' vanished from the set`)
  return asSchema(held.inputSchema).jsonSchema
}

type ShapeFields = {
  properties?: Record<string, { type?: string }>
  required?: string[]
}

const shape = (published: unknown): ShapeFields => {
  if (typeof published !== 'object' || published === null) return {}
  return published as ShapeFields
}

describe('toToolSet schema selection', () => {
  it('hands the raw JSON schema to the model when the declaration advertises one', () => {
    const raw = {
      type: 'object',
      properties: { limit: { type: 'number' }, flag: { type: 'boolean' } },
    } as const

    const fields = shape(publishedJson(declarationOf({ name: 'read', jsonSchema: raw })))

    expect(fields.properties?.['limit']).toEqual({ type: 'number' })
    expect(fields.properties?.['flag']).toEqual({ type: 'boolean' })
  })

  it('falls back to the zod schema when no raw schema is advertised', () => {
    const fields = shape(publishedJson(declarationOf({ name: 'read' })))

    expect(fields.properties).toMatchObject({ path: { type: 'string' } })
  })
})
