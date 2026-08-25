import type { Assembled, ProviderIdentity, ProviderPrompt } from '@dltech/atlas-core'

export const toProviderPrompt = (args: { assembled: Assembled; provider: ProviderIdentity }): ProviderPrompt => ({
  instructions: args.assembled.system,
  messages: args.assembled.messages.map((assembled) => assembled.message),
  provider: args.provider,
})
