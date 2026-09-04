import { EAuthProvider, providerSpec, type ClockPort, type OauthTokens } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from '../credential-error'
import { AnthropicOauthClient, type OauthLogin, type Pkce } from './anthropic-oauth-client'
import { CodexOauthClient } from './codex-oauth-client'
import type { DeviceLoginClient } from './device-login'

export interface RefreshClient {
  refresh(args: { refreshToken: string }): Promise<OauthTokens>
}

export interface LoginClient {
  generatePkce(): Pkce
  authorizeUrl(pkce: Pkce): string
  exchange(args: { pasted: string; pkce: Pkce }): Promise<OauthLogin>
}

/** A provider's login shape is its own: Anthropic pastes a code back, OpenAI polls a device code. */
export interface OauthClient extends RefreshClient, Partial<LoginClient>, Partial<DeviceLoginClient> {}

export const canPasteLogin = (client: OauthClient): client is OauthClient & LoginClient =>
  typeof client.generatePkce === 'function' && typeof client.exchange === 'function'

export const canDeviceLogin = (client: OauthClient): client is OauthClient & DeviceLoginClient =>
  typeof client.startDeviceLogin === 'function' && typeof client.pollDeviceLogin === 'function'

export type RefreshClients = Partial<Record<EAuthProvider, RefreshClient>>

export type OauthClients = Partial<Record<EAuthProvider, OauthClient>>

export const builtinOauthClients = (args: { clock: ClockPort }): OauthClients => ({
  [EAuthProvider.Anthropic]: new AnthropicOauthClient({ clock: args.clock }),
  [EAuthProvider.OpenAI]: new CodexOauthClient({ clock: args.clock }),
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
