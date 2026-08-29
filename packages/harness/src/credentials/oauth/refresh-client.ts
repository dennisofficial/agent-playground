import { EAuthProvider, providerSpec, type ClockPort, type OauthTokens } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from '../credential-error'
import { AnthropicOauthClient, type OauthLogin, type Pkce } from './anthropic-oauth-client'

export interface RefreshClient {
  refresh(args: { refreshToken: string }): Promise<OauthTokens>
}

export interface LoginClient {
  generatePkce(): Pkce
  authorizeUrl(pkce: Pkce): string
  exchange(args: { pasted: string; pkce: Pkce }): Promise<OauthLogin>
}

export interface OauthClient extends RefreshClient, LoginClient {}

export type RefreshClients = Partial<Record<EAuthProvider, RefreshClient>>

export type OauthClients = Partial<Record<EAuthProvider, OauthClient>>

export const builtinOauthClients = (args: { clock: ClockPort }): OauthClients => ({
  [EAuthProvider.Anthropic]: new AnthropicOauthClient({ clock: args.clock }),
})

export const unsupportedProvider = (provider: EAuthProvider): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.StoreUnavailable,
    message: `Atlas cannot sign in to ${providerSpec(provider).label} yet.`,
  })

export const clientFor = <TClient>(args: {
  clients: Partial<Record<EAuthProvider, TClient>>
  provider: EAuthProvider
}): TClient => {
  const client = args.clients[args.provider]
  if (client === undefined) throw unsupportedProvider(args.provider)

  return client
}
