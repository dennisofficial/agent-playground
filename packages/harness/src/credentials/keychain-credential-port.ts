import type { ClockPort, Credential, CredentialPort } from '@dltech/atlas-core'

import { injectable } from '../container/injection'
import { parseClaudeCredentialBlob } from './claude-credential-blob'
import { assertCredentialIsUnexpired } from './expiry'
import type { KeychainReader } from './keychain-reader'

export const CLAUDE_CODE_CREDENTIAL_SERVICE = 'Claude Code-credentials'

@injectable()
export class KeychainCredentialPort implements CredentialPort {
  private readonly reader: KeychainReader
  private readonly clock: ClockPort
  private readonly service: string

  constructor(args: { reader: KeychainReader; clock: ClockPort; service?: string }) {
    this.reader = args.reader
    this.clock = args.clock
    this.service = args.service ?? CLAUDE_CODE_CREDENTIAL_SERVICE
  }

  async read(): Promise<Credential> {
    const payload = await this.reader.readGenericPassword({ service: this.service })
    const credential = parseClaudeCredentialBlob(payload)

    assertCredentialIsUnexpired({ credential, now: this.clock.now() })

    return credential
  }
}
