import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  TAKES_NO_PATHS,
  type DeclaredPathField,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { ABSENT, createDeclaredPaths, EPathDeclaration, inputFieldOf } from '../declared-paths'

const pathField: DeclaredPathField = {
  field: 'path',
  presence: EPathPresence.Required,
  form: EPathForm.Absolute,
  content: EContentAccess.Reads,
}

const declaration = (args: {
  name: string
  pathFields?: ToolDeclaration['pathFields']
}): ToolDeclaration => ({
  name: args.name,
  description: `the ${args.name} tool`,
  effect: EToolEffect.Read,
  inputSchema: z.unknown(),
  ...(args.pathFields === undefined ? {} : { pathFields: args.pathFields }),
})

describe('inputFieldOf', () => {
  it('returns a field that is present on a record input', () => {
    expect(inputFieldOf({ input: { path: '/tmp/a.ts' }, field: 'path' })).toBe('/tmp/a.ts')
  })

  it('returns a present field that is not a string, leaving the type check to the caller', () => {
    expect(inputFieldOf({ input: { path: 7 }, field: 'path' })).toBe(7)
    expect(inputFieldOf({ input: { path: null }, field: 'path' })).toBe(null)
  })

  it('returns ABSENT for a field the input does not carry', () => {
    expect(inputFieldOf({ input: { other: '/tmp/a.ts' }, field: 'path' })).toBe(ABSENT)
    expect(inputFieldOf({ input: {}, field: 'path' })).toBe(ABSENT)
  })

  it('returns ABSENT for a field explicitly set to undefined', () => {
    expect(inputFieldOf({ input: { path: undefined }, field: 'path' })).toBe(ABSENT)
  })

  it('returns ABSENT when the input is not a record', () => {
    expect(inputFieldOf({ input: '/tmp/a.ts', field: 'path' })).toBe(ABSENT)
    expect(inputFieldOf({ input: null, field: 'path' })).toBe(ABSENT)
    expect(inputFieldOf({ input: undefined, field: 'path' })).toBe(ABSENT)
    expect(inputFieldOf({ input: 7, field: 'path' })).toBe(ABSENT)
    expect(inputFieldOf({ input: true, field: 'path' })).toBe(ABSENT)
  })
})

describe('createDeclaredPaths', () => {
  it('reports a tool it has never heard of as unregistered', () => {
    const declaredPaths = createDeclaredPaths({ tools: [declaration({ name: 'read', pathFields: [pathField] })] })

    expect(declaredPaths.forTool('mcp__unknown__do')).toEqual({ kind: EPathDeclaration.Unregistered })
  })

  it('reports a registered tool that never declared its path fields as undeclared', () => {
    const declaredPaths = createDeclaredPaths({ tools: [declaration({ name: 'mystery' })] })

    expect(declaredPaths.forTool('mystery')).toEqual({ kind: EPathDeclaration.Undeclared })
  })

  it('reports the declared fields of a tool that declared some', () => {
    const declaredPaths = createDeclaredPaths({ tools: [declaration({ name: 'read', pathFields: [pathField] })] })

    expect(declaredPaths.forTool('read')).toEqual({
      kind: EPathDeclaration.Declared,
      fields: [pathField],
    })
  })

  it('reads an empty declared array as declaring no paths, not as never declaring', () => {
    const declaredPaths = createDeclaredPaths({ tools: [declaration({ name: 'bash', pathFields: TAKES_NO_PATHS })] })

    expect(declaredPaths.forTool('bash')).toEqual({ kind: EPathDeclaration.Declared, fields: [] })
  })

  it('keeps the three cases apart across one lookup table', () => {
    const declaredPaths = createDeclaredPaths({
      tools: [
        declaration({ name: 'read', pathFields: [pathField] }),
        declaration({ name: 'bash', pathFields: TAKES_NO_PATHS }),
        declaration({ name: 'mystery' }),
      ],
    })

    expect(declaredPaths.forTool('read').kind).toBe(EPathDeclaration.Declared)
    expect(declaredPaths.forTool('bash').kind).toBe(EPathDeclaration.Declared)
    expect(declaredPaths.forTool('mystery').kind).toBe(EPathDeclaration.Undeclared)
    expect(declaredPaths.forTool('write').kind).toBe(EPathDeclaration.Unregistered)
  })
})
