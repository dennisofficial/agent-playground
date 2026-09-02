import { jsonSchema, tool, type ToolSet } from 'ai'

import type { ToolDeclaration } from '@dltech/atlas-core'

// Declaring a tool without `execute` is what stops the AI SDK's own loop after one step: it cannot
// manufacture a tool result, so it hands the call back. `stopWhen` documents the intent but does not
// enforce it. https://ai-sdk.dev/docs/agents/loop-control
export const toToolSet = (declarations: readonly ToolDeclaration[]): ToolSet =>
  Object.fromEntries(
    declarations.map((declaration) => [
      declaration.name,
      tool({
        description: declaration.description,
        // MCP tools carry the server's raw JSON schema beside the permissive zod record dispatch
        // validates against; the raw schema is what the model plans its call from.
        inputSchema:
          declaration.jsonSchema !== undefined
            ? jsonSchema(declaration.jsonSchema as Parameters<typeof jsonSchema>[0])
            : declaration.inputSchema,
      }),
    ]),
  )
