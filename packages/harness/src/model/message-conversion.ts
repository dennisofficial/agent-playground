import type {
  AssistantContent,
  ModelMessage,
  TextPart as ModelTextPart,
  ToolResultPart as ModelToolResultPart,
  ToolContent,
  UserContent,
} from 'ai'

import type {
  AssistantMessage,
  Message,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolMessage,
  ToolResultOutput,
  ToolResultPart,
  UserMessage,
} from '@dltech/atlas-core'

import { MessageConversionError } from './errors'
import { toCoreJsonValue } from './json-value'
import { carriedProviderOptions, toCoreProviderOptions } from './provider-options'

type ModelAssistantPart = Extract<AssistantContent, readonly unknown[]>[number]
type ModelToolResultOutput = ModelToolResultPart['output']
type CoreAssistantPart = AssistantMessage['content'][number]

const toModelTextPart = (part: TextPart) => ({
  type: 'text' as const,
  text: part.text,
  ...carriedProviderOptions(part.providerOptions),
})

const toModelReasoningPart = (part: ReasoningPart) => ({
  type: 'reasoning' as const,
  text: part.text,
  ...carriedProviderOptions(part.providerOptions),
})

const toModelToolCallPart = (part: ToolCallPart) => ({
  type: 'tool-call' as const,
  toolCallId: part.toolCallId,
  toolName: part.toolName,
  input: part.input,
  ...carriedProviderOptions(part.providerOptions),
})

const toModelToolResultPart = (part: ToolResultPart) => ({
  type: 'tool-result' as const,
  toolCallId: part.toolCallId,
  toolName: part.toolName,
  output: part.output,
  ...carriedProviderOptions(part.providerOptions),
})

const toModelAssistantPart = (part: CoreAssistantPart): ModelAssistantPart => {
  if (part.type === 'text') return toModelTextPart(part)
  if (part.type === 'reasoning') return toModelReasoningPart(part)
  return toModelToolCallPart(part)
}

export function toModelMessage(message: Message): ModelMessage {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: message.content.map(toModelTextPart),
      ...carriedProviderOptions(message.providerOptions),
    }
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content.map(toModelToolResultPart),
      ...carriedProviderOptions(message.providerOptions),
    }
  }

  return {
    role: 'assistant',
    content: message.content.map(toModelAssistantPart),
    ...carriedProviderOptions(message.providerOptions),
  }
}

export const toModelMessages = (messages: readonly Message[]): ModelMessage[] => messages.map(toModelMessage)

const refuse = (what: string): never => {
  throw new MessageConversionError(`cannot convert ${what} into a core message`)
}

const fromModelTextPart = (part: ModelTextPart): TextPart => ({
  type: 'text',
  text: part.text,
  ...carriedProviderOptions(toCoreProviderOptions(part.providerOptions)),
})

const fromModelUserContent = (content: UserContent): readonly TextPart[] => {
  if (typeof content === 'string') return [{ type: 'text', text: content }]

  return content.map((part) => (part.type === 'text' ? fromModelTextPart(part) : refuse(`a user ${part.type} part`)))
}

const fromModelAssistantPart = (part: ModelAssistantPart): CoreAssistantPart => {
  if (part.type === 'text') return fromModelTextPart(part)

  if (part.type === 'reasoning') {
    return {
      type: 'reasoning',
      text: part.text,
      ...carriedProviderOptions(toCoreProviderOptions(part.providerOptions)),
    }
  }

  if (part.type === 'tool-call') {
    return {
      type: 'tool-call',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
      ...carriedProviderOptions(toCoreProviderOptions(part.providerOptions)),
    }
  }

  return refuse(`an assistant ${part.type} part`)
}

const fromModelAssistantContent = (content: AssistantContent): readonly CoreAssistantPart[] => {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map(fromModelAssistantPart)
}

const fromModelToolResultOutput = (output: ModelToolResultOutput): ToolResultOutput => {
  if (output.type === 'text') return { type: 'text', value: output.value }
  if (output.type === 'error-text') return { type: 'error-text', value: output.value }
  if (output.type === 'json') return { type: 'json', value: toCoreJsonValue(output.value) }
  if (output.type === 'error-json') return { type: 'error-json', value: toCoreJsonValue(output.value) }
  return refuse(`a tool result output of type ${output.type}`)
}

const fromModelToolContent = (content: ToolContent): readonly ToolResultPart[] =>
  content.map((part) => {
    if (part.type !== 'tool-result') return refuse(`a tool ${part.type} part`)

    return {
      type: 'tool-result' as const,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: fromModelToolResultOutput(part.output),
      ...carriedProviderOptions(toCoreProviderOptions(part.providerOptions)),
    }
  })

export function fromModelMessage(message: ModelMessage): Message {
  if (message.role === 'system') return refuse('a system message, which belongs in the instructions')

  if (message.role === 'user') {
    const user: UserMessage = {
      role: 'user',
      content: fromModelUserContent(message.content),
      ...carriedProviderOptions(toCoreProviderOptions(message.providerOptions)),
    }
    return user
  }

  if (message.role === 'tool') {
    const tool: ToolMessage = {
      role: 'tool',
      content: fromModelToolContent(message.content),
      ...carriedProviderOptions(toCoreProviderOptions(message.providerOptions)),
    }
    return tool
  }

  const assistant: AssistantMessage = {
    role: 'assistant',
    content: fromModelAssistantContent(message.content),
    ...carriedProviderOptions(toCoreProviderOptions(message.providerOptions)),
  }
  return assistant
}

export const fromModelMessages = (messages: readonly ModelMessage[]): Message[] => messages.map(fromModelMessage)
