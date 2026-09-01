import type { JsonValue } from '../json/value'
import type { ProviderOptions } from '../provider'

export type TextPart = { type: 'text'; text: string; providerOptions?: ProviderOptions | undefined }

export type ReasoningPart = { type: 'reasoning'; text: string; providerOptions?: ProviderOptions | undefined }

export type ImagePart = {
  type: 'image'
  data: string
  mediaType: string
  source?: string | undefined
  width?: number | undefined
  height?: number | undefined
  providerOptions?: ProviderOptions | undefined
}

export type ToolCallPart = {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
  providerOptions?: ProviderOptions | undefined
}

export type ToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: JsonValue }
  | { type: 'error-text'; value: string }
  | { type: 'error-json'; value: JsonValue }
  | { type: 'content'; value: readonly (TextPart | ImagePart)[] }

export type ToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: ToolResultOutput
  providerOptions?: ProviderOptions | undefined
}

export type MessagePart = TextPart | ImagePart | ReasoningPart | ToolCallPart | ToolResultPart
