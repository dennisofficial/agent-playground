import { jsonSchema, tool, type ToolSet } from 'ai'

import type { ToolDeclaration } from '@dltech/atlas-core'

// Declaring a tool without `execute` is what stops the AI SDK's own loop after one step: it cannot
// manufacture a tool result, so it hands the call back. `stopWhen` documents the intent but does not
// enforce it. https://ai-sdk.dev/docs/agents/loop-control
// OpenAI's Responses API normalizes a function tool that omits `strict` into strict mode whenever
// the schema allows it, and strict mode treats every property as required — the model then fills
// genuinely optional parameters with fabricated values. Every other provider already defaults to
// non-strict, so pinning it is a no-op there. Codex pins strict: false on every tool for the same
// reason. https://developers.openai.com/api/docs/guides/function-calling#strict-mode
export const toToolSet = (declarations: readonly ToolDeclaration[]): ToolSet =>
  Object.fromEntries(
    declarations.map((declaration) => [
      declaration.name,
      tool({
        description: declaration.description,
        strict: false,
        // MCP tools carry the server's raw JSON schema beside the permissive zod record dispatch
        // validates against; the raw schema is what the model plans its call from.
        inputSchema:
          declaration.jsonSchema !== undefined
            ? jsonSchema(declaration.jsonSchema as Parameters<typeof jsonSchema>[0])
            : declaration.inputSchema,
      }),
    ]),
  )
