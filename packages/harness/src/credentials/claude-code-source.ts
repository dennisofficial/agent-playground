import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  EAccountOrigin,
  EAuthKind,
  EAuthProvider,
  type Account,
  type AccountStorePort,
  type OauthTokens,
} from '@dltech/atlas-core'

import { claudeCredentialBlob, parseClaudeCredentialBlob } from './claude-credential-blob'
import type { CredentialSink } from './credential-sink'
import type { KeychainReader } from './keychain-reader'
import { claudeCredentialsFile } from './paths'

export const CLAUDE_CODE_SOURCE_ID = 'claude-code'
export const CLAUDE_CODE_CREDENTIAL_SERVICE = 'Claude Code-credentials'

const OWNER_ONLY = 0o600

export interface ClaudeCodePayloadStore {
  read(): Promise<string | undefined>
  write(payload: string): Promise<void>
}

export const keychainPayloadStore = (args: {
  reader: KeychainReader
  service?: string
}): ClaudeCodePayloadStore => {
  const service = args.service ?? CLAUDE_CODE_CREDENTIAL_SERVICE

  return {
    read: async () => args.reader.readGenericPassword({ service }).catch(() => undefined),
    write: async (payload) => args.reader.writeGenericPassword({ service, payload }),
  }
}

export const filePayloadStore = (file: string = claudeCredentialsFile()): ClaudeCodePayloadStore => ({
  read: async () => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  },
  write: async (payload) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, payload, { mode: OWNER_ONLY })
    chmodSync(file, OWNER_ONLY)
  },
})

export const claudeCodePayloadStore = (args: { reader: KeychainReader }): ClaudeCodePayloadStore =>
  process.platform === 'darwin' ? keychainPayloadStore({ reader: args.reader }) : filePayloadStore()

export class ClaudeCodeSource implements CredentialSink {
  readonly id = CLAUDE_CODE_SOURCE_ID

  constructor(private readonly payloads: ClaudeCodePayloadStore) {}

  async read(): Promise<OauthTokens | undefined> {
    return (await this.credential())?.tokens
  }

  async write(tokens: OauthTokens): Promise<void> {
    const existing = await this.payloads.read()

    await this.payloads.write(
      claudeCredentialBlob({
        tokens,
        ...(existing === undefined ? {} : { existing }),
      }),
    )
  }

  async credential(): Promise<{ tokens: OauthTokens; subscription?: string } | undefined> {
    const payload = await this.payloads.read()
    if (payload === undefined) return undefined

    try {
      return parseClaudeCredentialBlob(payload)
    } catch {
      return undefined
    }
  }
}

/**
 * Take up a Claude Code login the first time Atlas runs, so an operator who already has one never
 * sees a login screen. Imported once and only once: after that the vault is the authority, and the
 * refresh path is what keeps both stores in step.
 */
export async function importClaudeCodeAccount(args: {
  accounts: AccountStorePort
  source: ClaudeCodeSource
}): Promise<Account | undefined> {
  const existing = await args.accounts.list()
  if (existing.some((account) => account.importedFrom === CLAUDE_CODE_SOURCE_ID)) return undefined

  const credential = await args.source.credential()
  if (credential === undefined) return undefined

  return args.accounts.add({
    provider: EAuthProvider.Anthropic,
    label:
      credential.subscription === undefined
        ? 'Claude Code'
        : `Claude Code (${credential.subscription})`,
    secret: { kind: EAuthKind.Oauth, tokens: credential.tokens },
    origin: EAccountOrigin.Imported,
    importedFrom: CLAUDE_CODE_SOURCE_ID,
    ...(credential.subscription === undefined ? {} : { subscription: credential.subscription }),
  })
}
