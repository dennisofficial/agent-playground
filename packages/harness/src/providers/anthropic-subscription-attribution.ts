import { createHash } from 'node:crypto'

import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'

const ATLAS_ATTRIBUTION_VERSION = '0.1.0'
const ATLAS_ENTRYPOINT = 'atlas'
const CLAUDE_CODE_FINGERPRINT_INDICES = [4, 7, 20] as const
const CLAUDE_CODE_FINGERPRINT_SALT = '59cf53e54c78'

const firstUserText = (options: LanguageModelV4CallOptions): string => {
  const firstUserMessage = options.prompt.find((message) => message.role === 'user')
  if (firstUserMessage === undefined) return ''

  const firstText = firstUserMessage.content.find((part) => part.type === 'text')
  return firstText?.text ?? ''
}

const fingerprintFor = (text: string): string => {
  const selectedCharacters = CLAUDE_CODE_FINGERPRINT_INDICES.map((index) => text[index] ?? '0').join('')
  return createHash('sha256')
    .update(`${CLAUDE_CODE_FINGERPRINT_SALT}${selectedCharacters}${ATLAS_ATTRIBUTION_VERSION}`)
    .digest('hex')
    .slice(0, 3)
}

const attributionFor = (options: LanguageModelV4CallOptions): string =>
  `x-anthropic-billing-header: cc_version=${ATLAS_ATTRIBUTION_VERSION}.${fingerprintFor(firstUserText(options))}; cc_entrypoint=${ATLAS_ENTRYPOINT};`

// Anthropic's undocumented subscription routing format was recovered from Claude Code 2.1.241
// and verified live on 2026-08-25. See docs/research/anthropic-oauth-transport.md.
export const withAnthropicSubscriptionAttribution = (
  options: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions => ({
  ...options,
  prompt: [{ role: 'system', content: attributionFor(options) }, ...options.prompt],
})
