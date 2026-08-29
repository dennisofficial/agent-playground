import { EAuthProvider, providerSpec, type ClockPort, type OauthTokens } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from '../credential-error'
import { AnthropicOauthClient } from './anthropic-oauth-client'

export interface RefreshClient {
  refresh(args: { refreshToken: string }): Promise<OauthTokens>
}

export type RefreshClients = Partial<Record<EAuthProvider, RefreshClient>>

export const builtinRefreshClients = (args: { clock: ClockPort }): RefreshClients => ({
  [EAuthProvider.Anthropic]: new AnthropicOauthClient({ clock: args.clock }),
})

export const refreshClientFor = (args: {
  clients: RefreshClients
  provider: EAuthProvider
}): RefreshClient => {
  const client = args.clients[args.provider]
  if (client !== undefined) return client

  throw new CredentialError({
    failure: ECredentialFailure.StoreUnavailable,
    message: `Atlas cannot refresh a ${providerSpec(args.provider).label} login yet. Sign in again with /auth.`,
  })
}
