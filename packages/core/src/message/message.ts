import type { ProviderOptions } from '../provider'
import type { ReasoningPart, TextPart, ToolCallPart, ToolResultPart } from './parts'

export type UserMessage = {
  role: 'user'
  content: readonly TextPart[]
  providerOptions?: ProviderOptions
}

export type AssistantMessage = {
  role: 'assistant'
  content: readonly (TextPart | ReasoningPart | ToolCallPart)[]
  providerOptions?: ProviderOptions
}

export type ToolMessage = {
  role: 'tool'
  content: readonly ToolResultPart[]
  providerOptions?: ProviderOptions
}

export type Message = UserMessage | AssistantMessage | ToolMessage

export type MessageRole = Message['role']
