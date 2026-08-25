import { tool, type ToolSet } from 'ai'

import type { ToolDeclaration } from '@dltech/atlas-core'

// Declaring a tool without `execute` is what stops the AI SDK's own loop after one step: it cannot
// manufacture a tool result, so it hands the call back. `stopWhen` documents the intent but does not
// enforce it. https://ai-sdk.dev/docs/agents/loop-control
export const toToolSet = (declarations: readonly ToolDeclaration[]): ToolSet =>
  Object.fromEntries(
    declarations.map((declaration) => [
      declaration.name,
      tool({ description: declaration.description, inputSchema: declaration.inputSchema }),
    ]),
  )
