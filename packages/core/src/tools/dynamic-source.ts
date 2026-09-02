import type { ToolDeclaration, ToolDefinition } from './tool'

/**
 * A slot for tool providers whose set changes while the process runs — a server that connects
 * late or drops off mid-session. Register implementations as `portToken(DynamicToolSource)`; the
 * composite registry unions them over the static set, and the loop reads the union per model step.
 */
export abstract class DynamicToolSource {
  abstract declarations(): readonly ToolDeclaration[]
  abstract find(name: string): ToolDefinition | undefined
}
