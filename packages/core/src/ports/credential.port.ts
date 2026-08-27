export type Credential = { accessToken: string; expiresAt: string }

export abstract class CredentialPort {
  abstract read(): Promise<Credential>
}
