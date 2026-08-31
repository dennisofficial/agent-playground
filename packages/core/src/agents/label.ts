const QUOTED_INTENT_CHARACTERS = 120

const ELLIPSIS = '…'

export function quotedAgentIntent(intent: string): string {
  const single = intent.replace(/\s+/g, ' ').trim()
  if (single === '') return ''
  const shown =
    single.length <= QUOTED_INTENT_CHARACTERS
      ? single
      : `${single.slice(0, QUOTED_INTENT_CHARACTERS)}${ELLIPSIS}`
  return `"${shown}"`
}

export function agentLabel(args: { agentType: string; intent: string }): string {
  const quoted = quotedAgentIntent(args.intent)
  return quoted === '' ? args.agentType : `${args.agentType} ${quoted}`
}
