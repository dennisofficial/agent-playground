import type { EventRef } from '../events/envelope'
import type { Message } from '../message/message'
import type { MessagePart, ToolCallPart, ToolResultPart } from '../message/parts'
import type { Assembled, AssembledMessage } from './assembled'

export enum EExchangeFault {
  OpensWithAssistant = 'opens-with-assistant',
  EmptyContent = 'empty-content',
  BlankText = 'blank-text',
  RepeatedCallId = 'repeated-call-id',
  RepeatedResultId = 'repeated-result-id',
  UnansweredCall = 'unanswered-call',
  UnmatchedResult = 'unmatched-result',
  ResultAfterOtherContent = 'result-after-other-content',
}

export type ExchangeFault = {
  fault: EExchangeFault
  messageIndex: number
  origin: EventRef
  detail: string
  toolCallId?: string | undefined
}

enum ETurnRole {
  Assistant = 'assistant',
  User = 'user',
}

type Placed = { entry: AssembledMessage; index: number }

type Turn = { role: ETurnRole; placed: Placed[] }

type PlacedPart<TPart> = { part: TPart; placed: Placed }

const partsOf = (message: Message): readonly MessagePart[] => message.content

const turnRoleOf = (message: Message): ETurnRole =>
  message.role === 'assistant' ? ETurnRole.Assistant : ETurnRole.User

function providerTurns(messages: readonly AssembledMessage[]): Turn[] {
  const turns: Turn[] = []

  messages.forEach((entry, index) => {
    const role = turnRoleOf(entry.message)
    const open = turns.at(-1)

    if (open?.role === role) {
      open.placed.push({ entry, index })
      return
    }

    turns.push({ role, placed: [{ entry, index }] })
  })

  return turns
}

function faultAt(args: {
  fault: EExchangeFault
  placed: Placed
  detail: string
  toolCallId?: string
}): ExchangeFault {
  return {
    fault: args.fault,
    messageIndex: args.placed.index,
    origin: args.placed.entry.origin,
    detail: args.detail,
    ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
  }
}

function callsIn(turn: Turn): PlacedPart<ToolCallPart>[] {
  return turn.placed.flatMap((placed) => {
    const { message } = placed.entry
    if (message.role !== 'assistant') return []

    return message.content
      .filter((part): part is ToolCallPart => part.type === 'tool-call')
      .map((part) => ({ part, placed }))
  })
}

function resultsIn(turn: Turn): PlacedPart<ToolResultPart>[] {
  return turn.placed.flatMap((placed) => {
    const { message } = placed.entry
    if (message.role !== 'tool') return []

    return message.content.map((part) => ({ part, placed }))
  })
}

function contentFaults(placed: Placed): ExchangeFault[] {
  const { message } = placed.entry
  const parts = partsOf(message)

  if (parts.length === 0) {
    return [
      faultAt({
        fault: EExchangeFault.EmptyContent,
        placed,
        detail: `the ${message.role} message holds no content parts`,
      }),
    ]
  }

  return parts.flatMap((part, position) =>
    part.type === 'text' && part.text === ''
      ? [
          faultAt({
            fault: EExchangeFault.BlankText,
            placed,
            detail: `part ${position} of the ${message.role} message is a text block holding no text`,
          }),
        ]
      : [],
  )
}

function orderFaults(turn: Turn): ExchangeFault[] {
  if (turn.role !== ETurnRole.User) return []

  const faults: ExchangeFault[] = []
  let precededByOtherContent = false

  for (const placed of turn.placed) {
    for (const part of partsOf(placed.entry.message)) {
      if (part.type !== 'tool-result') {
        precededByOtherContent = true
        continue
      }

      if (!precededByOtherContent) continue

      faults.push(
        faultAt({
          fault: EExchangeFault.ResultAfterOtherContent,
          placed,
          toolCallId: part.toolCallId,
          detail: `the result for ${part.toolCallId} follows other content in the same turn, and the provider merges that turn into one message whose results must come first`,
        }),
      )
    }
  }

  return faults
}

function unansweredFaults(args: { turn: Turn; next: Turn | undefined }): ExchangeFault[] {
  if (args.turn.role !== ETurnRole.Assistant) return []

  const answered = new Set(
    args.next === undefined ? [] : resultsIn(args.next).map(({ part }) => part.toolCallId),
  )

  return callsIn(args.turn)
    .filter(({ part }) => !answered.has(part.toolCallId))
    .map(({ part, placed }) =>
      faultAt({
        fault: EExchangeFault.UnansweredCall,
        placed,
        toolCallId: part.toolCallId,
        detail: `the call ${part.toolCallId} to ${part.toolName} has no result in the turn that follows it`,
      }),
    )
}

function unmatchedFaults(args: { turn: Turn; previous: Turn | undefined }): ExchangeFault[] {
  if (args.turn.role !== ETurnRole.User) return []

  const answerable = new Set(
    args.previous === undefined ? [] : callsIn(args.previous).map(({ part }) => part.toolCallId),
  )

  return resultsIn(args.turn)
    .filter(({ part }) => !answerable.has(part.toolCallId))
    .map(({ part, placed }) =>
      faultAt({
        fault: EExchangeFault.UnmatchedResult,
        placed,
        toolCallId: part.toolCallId,
        detail: `the result for ${part.toolCallId} answers no call in the turn that precedes it`,
      }),
    )
}

function repeatedIdFaults(args: {
  placedParts: readonly PlacedPart<ToolCallPart | ToolResultPart>[]
  fault: EExchangeFault
  subject: string
}): ExchangeFault[] {
  const seen = new Set<string>()

  return args.placedParts.flatMap(({ part, placed }) => {
    if (!seen.has(part.toolCallId)) {
      seen.add(part.toolCallId)
      return []
    }

    return [
      faultAt({
        fault: args.fault,
        placed,
        toolCallId: part.toolCallId,
        detail: `${part.toolCallId} is used by more than one ${args.subject} in this exchange`,
      }),
    ]
  })
}

function openingFaults(messages: readonly AssembledMessage[]): ExchangeFault[] {
  const first = messages[0]
  if (first === undefined || first.message.role !== 'assistant') return []

  return [
    faultAt({
      fault: EExchangeFault.OpensWithAssistant,
      placed: { entry: first, index: 0 },
      detail: 'the exchange opens with an assistant message, and the first message must be the user',
    }),
  ]
}

export function exchangeFaults(assembled: Assembled): readonly ExchangeFault[] {
  const { messages } = assembled
  const turns = providerTurns(messages)

  const faults = [
    ...openingFaults(messages),
    ...messages.flatMap((entry, index) => contentFaults({ entry, index })),
    ...turns.flatMap((turn) => orderFaults(turn)),
    ...turns.flatMap((turn, position) => unansweredFaults({ turn, next: turns[position + 1] })),
    ...turns.flatMap((turn, position) => unmatchedFaults({ turn, previous: turns[position - 1] })),
    ...repeatedIdFaults({
      placedParts: turns.flatMap(callsIn),
      fault: EExchangeFault.RepeatedCallId,
      subject: 'call',
    }),
    ...repeatedIdFaults({
      placedParts: turns.flatMap(resultsIn),
      fault: EExchangeFault.RepeatedResultId,
      subject: 'result',
    }),
  ]

  return faults.sort((left, right) => left.messageIndex - right.messageIndex)
}
