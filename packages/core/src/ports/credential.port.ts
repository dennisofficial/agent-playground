import { EAuthKind, type AccountId, type EAuthProvider } from '../credentials/account'

export type OauthCredential = {
  kind: EAuthKind.Oauth
  accountId: AccountId
  accessToken: string
  expiresAt: string
}

export type ApiKeyCredential = {
  kind: EAuthKind.ApiKey
  accountId: AccountId
  apiKey: string
}

export type Credential = OauthCredential | ApiKeyCredential

export type CredentialRequest = {
  provider?: EAuthProvider | undefined
  accountId?: AccountId | undefined
}

export abstract class CredentialPort {
  abstract read(request?: CredentialRequest): Promise<Credential>
}

export const secretOf = (credential: Credential): string =>
  credential.kind === EAuthKind.Oauth ? credential.accessToken : credential.apiKey
