export type Credential = { accessToken: string; expiresAt: string }

export interface CredentialPort {
  read(): Promise<Credential>
}
