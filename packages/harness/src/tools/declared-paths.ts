import { z } from 'zod'

import { declaredFieldsOf, type DeclaredPathField, type ToolDeclaration } from '@dltech/atlas-core'

export const ABSENT = Symbol('absent')

const inputRecordSchema = z.record(z.string(), z.unknown())

export function inputFieldOf({ input, field }: { input: unknown; field: string }): unknown {
  const parsed = inputRecordSchema.safeParse(input)
  if (!parsed.success) return ABSENT

  const value = parsed.data[field]
  return value === undefined ? ABSENT : value
}

export enum EPathDeclaration {
  Unregistered = 'unregistered',
  Undeclared = 'undeclared',
  Declared = 'declared',
}

export type PathDeclaration =
  | { kind: EPathDeclaration.Unregistered }
  | { kind: EPathDeclaration.Undeclared }
  | { kind: EPathDeclaration.Declared; fields: readonly DeclaredPathField[] }

export type DeclaredPaths = {
  forTool(name: string): PathDeclaration
}

export function createDeclaredPaths(args: { tools: readonly ToolDeclaration[] }): DeclaredPaths {
  const fieldsByTool = new Map(args.tools.map((tool) => [tool.name, tool.pathFields]))

  return {
    forTool: (name) => {
      if (!fieldsByTool.has(name)) return { kind: EPathDeclaration.Unregistered }

      const claim = fieldsByTool.get(name)
      if (claim === undefined) return { kind: EPathDeclaration.Undeclared }

      return { kind: EPathDeclaration.Declared, fields: declaredFieldsOf({ claim }) }
    },
  }
}
