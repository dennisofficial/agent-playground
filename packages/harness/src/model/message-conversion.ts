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
  ImagePart,
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
type ModelUserPart = Extract<UserContent, readonly unknown[]>[number]
type ModelImagePart = Extract<ModelUserPart, { type: 'image' }>
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

const toModelToolResultOutput = (output: ToolResultOutput): ModelToolResultOutput => {
  if (output.type !== 'content') return output

  return {
    type: 'content',
    value: output.value.map((part) =>
      part.type === 'image'
        ? {
            type: 'file' as const,
            data: { type: 'data' as const, data: part.data },
            mediaType: part.mediaType,
          }
        : { type: 'text' as const, text: part.text },
    ),
  }
}

const toModelToolResultPart = (part: ToolResultPart) => ({
  type: 'tool-result' as const,
  toolCallId: part.toolCallId,
  toolName: part.toolName,
  output: toModelToolResultOutput(part.output),
  ...carriedProviderOptions(part.providerOptions),
})

const toModelImagePart = (part: ImagePart) => ({
  type: 'image' as const,
  image: part.data,
  mediaType: part.mediaType,
  ...carriedProviderOptions(part.providerOptions),
})

const toModelUserPart = (part: TextPart | ImagePart) =>
  part.type === 'image' ? toModelImagePart(part) : toModelTextPart(part)

const toModelAssistantPart = (part: CoreAssistantPart): ModelAssistantPart => {
  if (part.type === 'text') return toModelTextPart(part)
  if (part.type === 'reasoning') return toModelReasoningPart(part)
  return toModelToolCallPart(part)
}

export function toModelMessage(message: Message): ModelMessage {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: message.content.map(toModelUserPart),
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

const REMOTE_IMAGE = /^(?:https?:|data:)/i

const fromModelImagePart = (part: ModelImagePart): ImagePart => {
  if (typeof part.image !== 'string' || REMOTE_IMAGE.test(part.image)) {
    return refuse('a user image part that is not inline base64')
  }

  return {
    type: 'image',
    data: part.image,
    mediaType: part.mediaType ?? 'image/png',
    ...carriedProviderOptions(toCoreProviderOptions(part.providerOptions)),
  }
}

const fromModelUserContent = (content: UserContent): readonly (TextPart | ImagePart)[] => {
  if (typeof content === 'string') return [{ type: 'text', text: content }]

  return content.map((part) => {
    if (part.type === 'text') return fromModelTextPart(part)
    if (part.type === 'image') return fromModelImagePart(part)
    return refuse(`a user ${part.type} part`)
  })
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

  if (output.type === 'content') {
    return {
      type: 'content',
      value: output.value.map((part) => {
        if (part.type === 'text') return { type: 'text' as const, text: part.text }

        if (part.type === 'file-data') {
          return { type: 'image' as const, data: part.data, mediaType: part.mediaType }
        }

        if (part.type !== 'file') return refuse(`a tool result ${part.type} part`)

        if (part.data.type !== 'data' || typeof part.data.data !== 'string') {
          return refuse('a tool result file that is not inline base64')
        }

        return { type: 'image' as const, data: part.data.data, mediaType: part.mediaType }
      }),
    }
  }

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
