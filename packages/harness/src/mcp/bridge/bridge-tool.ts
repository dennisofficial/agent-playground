import {
  EToolEffect,
  ToolDefinition,
  type ImagePart,
  type ModelPart,
  type TextPart,
  type ToolInvocation,
  type ToolOutcome,
} from '@dltech/atlas-core'
import { z } from 'zod'

import { asRecord, type McpJson, type McpToolInfo, type ServerTransport } from '../transport'

// MCP tool results arrive as loose JSON from a server Atlas does not own, so blocks are narrowed
// individually rather than cast to a pre-formed shape, per the 2025-06-18 tool-result schema.
// https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result

export const MCP_NAME_PREFIX = 'mcp__'

export const MAX_MODEL_TEXT_CHARACTERS = 30_000

const TRUNCATION_NOTE = `[the result exceeded ${MAX_MODEL_TEXT_CHARACTERS} characters, so this text is the front of it]`

type McpAnnotations = { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined }

const annotationsOf = (raw: unknown): McpAnnotations => {
  const hints = asRecord(raw as McpJson | undefined)
  if (hints === undefined) return {}

  const readOnly = hints['readOnlyHint']
  const destructive = hints['destructiveHint']
  return {
    ...(typeof readOnly === 'boolean' ? { readOnlyHint: readOnly } : {}),
    ...(typeof destructive === 'boolean' ? { destructiveHint: destructive } : {}),
  }
}

const effectOf = (raw: unknown): EToolEffect => {
  const annotations = annotationsOf(raw)
  if (annotations.readOnlyHint === true) return EToolEffect.Read
  if (annotations.destructiveHint === true) return EToolEffect.Destructive
  return EToolEffect.Write
}

const textBlockOf = (block: unknown): string | undefined => {
  const record = asRecord(block as McpJson | undefined)
  if (record === undefined || record['type'] !== 'text') return undefined
  return typeof record['text'] === 'string' ? record['text'] : undefined
}

const imageBlockOf = (block: unknown): ImagePart | undefined => {
  const record = asRecord(block as McpJson | undefined)
  if (record === undefined || record['type'] !== 'image') return undefined
  if (typeof record['data'] !== 'string' || typeof record['mimeType'] !== 'string') return undefined
  return { type: 'image', data: record['data'], mediaType: record['mimeType'] }
}

const stringifyRaw = (raw: unknown): string => (typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '')

const capText = (text: string): { text: string; truncated: boolean } => {
  if (text.length <= MAX_MODEL_TEXT_CHARACTERS) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_MODEL_TEXT_CHARACTERS)}\n${TRUNCATION_NOTE}`, truncated: true }
}

function renderContent(raw: unknown): { parts: readonly ModelPart[]; text: string; hasImages: boolean } {
  if (raw === undefined) return { parts: [], text: '', hasImages: false }

  if (!Array.isArray(raw)) {
    const rendered = capText(stringifyRaw(raw))
    return { parts: [{ type: 'text', text: rendered.text }], text: rendered.text, hasImages: false }
  }

  const texts: TextPart[] = []
  const images: ImagePart[] = []
  for (const block of raw) {
    const image = imageBlockOf(block)
    const text = textBlockOf(block)
    if (image !== undefined) images.push(image)
    else if (text !== undefined) texts.push({ type: 'text', text })
  }
  const joined = texts.map((part) => part.text).join('\n')
  const rendered = capText(joined)
  return { parts: [{ type: 'text', text: rendered.text }, ...images], text: rendered.text, hasImages: images.length > 0 }
}

export type TransportLookup = (serverId: string) => ServerTransport | undefined

export class McpBridgeTool extends ToolDefinition {
  override readonly effect: EToolEffect
  override readonly name: string
  override readonly description: string
  override readonly inputSchema = z.record(z.string(), z.unknown())

  readonly serverId: string
  readonly toolName: string
  private readonly info: McpToolInfo
  private readonly lookup: TransportLookup

  constructor(args: { serverId: string; info: McpToolInfo; transportOf: TransportLookup }) {
    super()
    this.serverId = args.serverId
    this.toolName = args.info.name
    this.info = args.info
    this.lookup = args.transportOf
    this.effect = effectOf(args.info.annotations)
    this.name = `${MCP_NAME_PREFIX}${args.serverId}__${args.info.name}`
    this.description = args.info.description ?? this.name

    if (this.effect === EToolEffect.Read) {
      this.isConcurrencySafe = () => true
    }
  }

  get jsonSchema(): unknown {
    return this.info.inputSchema
  }

  override async invoke(args: ToolInvocation): Promise<ToolOutcome> {
    const transport = this.lookup(this.serverId)
    if (transport === undefined) return { ok: false, reason: `the '${this.serverId}' MCP server is not connected` }

    let result
    try {
      result = await transport.callTool({ name: this.info.name, input: args.input })
    } catch (error) {
      return {
        ok: false,
        reason: `the '${this.serverId}' MCP server rejected the call: ${(error as Error).message}`,
      }
    }

    const structured = result.structuredContent
    const rendered = renderContent(structured ?? result.content)
    if (result.isError === true) return { ok: false, reason: rendered.text }

    return {
      ok: true,
      output: structured ?? result,
      modelText: rendered.text,
      ...(rendered.hasImages ? { modelParts: rendered.parts } : {}),
    }
  }
}
