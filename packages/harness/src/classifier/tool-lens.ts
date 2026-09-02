import { z } from 'zod'

import {
  declaredFieldsOf,
  deedsOf,
  EPathClaim,
  EPathDeclaration,
  EToolEffect,
  readCommand,
  toCallId,
  toThreadId,
  type ActLens,
  type CommandReading,
  type PathDeclarationView,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

export const SHELL_TOOL_NAME = 'bash'

const shellInputSchema = z.object({
  command: z.string().min(1),
  workdir: z.string().min(1).optional(),
})

const UNREGISTERED: PathDeclarationView = { kind: EPathDeclaration.Unregistered }

const RECALLED_CALL_ID = toCallId('recalled')
const RECALLED_THREAD_ID = toThreadId('recalled')

export type ToolLens = {
  declarationFor(name: string): PathDeclarationView
  effectOf(name: string): EToolEffect
  readingFor(args: {
    name: string
    input: unknown
    projectDirectory: string
  }): CommandReading | undefined
  actLensFor(args: { projectDirectory: string }): ActLens
}

function viewOf({ declaration }: { declaration: ToolDeclaration }): PathDeclarationView {
  const claim = declaration.pathFields
  if (claim === undefined || claim === EPathClaim.PathsItCannotName) {
    return { kind: EPathDeclaration.Undeclared }
  }
  if (claim === EPathClaim.TouchesNoPaths) return { kind: EPathDeclaration.TouchesNoPaths }
  return { kind: EPathDeclaration.Declared, fields: declaredFieldsOf({ claim }) }
}

export function toolLensFor({ tools }: { tools: readonly ToolDeclaration[] }): ToolLens {
  const byName = new Map(tools.map((declaration) => [declaration.name, declaration]))

  const declarationFor = (name: string): PathDeclarationView => {
    const declaration = byName.get(name)
    return declaration === undefined ? UNREGISTERED : viewOf({ declaration })
  }

  const effectOf = (name: string): EToolEffect =>
    byName.get(name)?.effect ?? EToolEffect.Destructive

  const readingFor = ({
    name,
    input,
    projectDirectory,
  }: {
    name: string
    input: unknown
    projectDirectory: string
  }): CommandReading | undefined => {
    if (name !== SHELL_TOOL_NAME) return undefined

    const parsed = shellInputSchema.safeParse(input)
    if (!parsed.success) return undefined

    return readCommand({
      command: parsed.data.command,
      workdir: parsed.data.workdir,
      projectDirectory,
    })
  }

  const actLensFor = ({ projectDirectory }: { projectDirectory: string }): ActLens => {
    return ({ name, input }) => {
      const effect = effectOf(name)
      const call: ToolCall = {
        callId: RECALLED_CALL_ID,
        name,
        input,
        effect,
        threadId: RECALLED_THREAD_ID,
      }

      return {
        effect,
        deeds: deedsOf({
          call,
          declaration: declarationFor(name),
          reading: readingFor({ name, input, projectDirectory }),
          projectDirectory,
        }),
      }
    }
  }

  return { declarationFor, effectOf, readingFor, actLensFor }
}
