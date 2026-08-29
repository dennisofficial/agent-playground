import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  AccountStorePort,
  accountSecretSchema,
  EAccountStatus,
  toAccountId,
  type Account,
  type AccountDraft,
  type AccountId,
  type AccountSecret,
  type ClockPort,
  type EAuthProvider,
  type StoredAccount,
} from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from './credential-error'
import type { SecretCipher } from './secret-cipher'
import { emptyVault, vaultFileSchema, type SealedAccount, type VaultFile } from './vault-file'

const OWNER_ONLY = 0o600

const unreadableVault = (file: string, detail: string): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.Unreadable,
    message: `The account vault at ${file} could not be read: ${detail}. Move it aside and sign in again with /auth.`,
  })

export class FileAccountStore extends AccountStorePort {
  private readonly file: string
  private readonly cipher: SecretCipher
  private readonly clock: ClockPort
  private writes: Promise<unknown> = Promise.resolve()

  constructor(args: { file: string; cipher: SecretCipher; clock: ClockPort }) {
    super()
    this.file = args.file
    this.cipher = args.cipher
    this.clock = args.clock
  }

  async list(): Promise<readonly Account[]> {
    return this.load().accounts.map(withoutSecret)
  }

  async read(accountId: AccountId): Promise<StoredAccount | undefined> {
    const sealed = this.load().accounts.find((account) => account.id === accountId)
    if (sealed === undefined) return undefined

    return { ...sealed, secret: this.unseal(sealed) }
  }

  async add(draft: AccountDraft): Promise<Account> {
    const at = this.clock.now()
    const account: Account = {
      id: toAccountId(`acc_${randomUUID()}`),
      provider: draft.provider,
      kind: draft.secret.kind,
      origin: draft.origin,
      label: draft.label,
      status: EAccountStatus.Active,
      ...(draft.email === undefined ? {} : { email: draft.email }),
      ...(draft.subscription === undefined ? {} : { subscription: draft.subscription }),
      ...(draft.importedFrom === undefined ? {} : { importedFrom: draft.importedFrom }),
      createdAt: at,
      updatedAt: at,
    }

    await this.mutate((vault) => ({
      ...vault,
      accounts: [...vault.accounts, { ...account, secret: this.cipher.encrypt(serialise(draft.secret)) }],
      active:
        vault.active[draft.provider] === undefined
          ? { ...vault.active, [draft.provider]: account.id }
          : vault.active,
    }))

    return account
  }

  /**
   * A credential that has just been accepted is proof that an `expired` status is out of date, and
   * nothing else ever writes `active` back — which is how one failed refresh used to retire an
   * account permanently.
   */
  async replaceSecret(args: { accountId: AccountId; secret: AccountSecret }): Promise<void> {
    const sealed = this.cipher.encrypt(serialise(args.secret))

    await this.mutateAccount({
      accountId: args.accountId,
      change: (account) => ({
        ...account,
        secret: sealed,
        kind: args.secret.kind,
        status: EAccountStatus.Active,
        updatedAt: this.clock.now(),
      }),
    })
  }

  async setStatus(args: { accountId: AccountId; status: EAccountStatus }): Promise<void> {
    await this.mutateAccount({
      accountId: args.accountId,
      change: (account) => ({ ...account, status: args.status, updatedAt: this.clock.now() }),
    })
  }

  async remove(accountId: AccountId): Promise<void> {
    await this.mutate((vault) => ({
      ...vault,
      accounts: vault.accounts.filter((account) => account.id !== accountId),
      active: Object.fromEntries(
        Object.entries(vault.active).filter(([, id]) => id !== accountId),
      ) as VaultFile['active'],
    }))
  }

  async setActive(args: { provider: EAuthProvider; accountId: AccountId }): Promise<void> {
    await this.mutate((vault) => ({
      ...vault,
      active: { ...vault.active, [args.provider]: args.accountId },
    }))
  }

  async activeFor(provider: EAuthProvider): Promise<AccountId | undefined> {
    return this.load().active[provider]
  }

  private unseal(sealed: SealedAccount): AccountSecret {
    const parsed = accountSecretSchema.safeParse(JSON.parse(this.cipher.decrypt(sealed.secret)))
    if (!parsed.success) throw unreadableVault(this.file, `the secret for ${sealed.label} is malformed`)

    return parsed.data
  }

  private load(): VaultFile {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return emptyVault()
    }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw unreadableVault(this.file, 'the file is not valid JSON')
    }

    const parsed = vaultFileSchema.safeParse(json)
    if (!parsed.success) throw unreadableVault(this.file, 'the file does not hold an account vault')

    return parsed.data
  }

  private async mutateAccount(args: {
    accountId: AccountId
    change: (account: SealedAccount) => SealedAccount
  }): Promise<void> {
    await this.mutate((vault) => ({
      ...vault,
      accounts: vault.accounts.map((account) =>
        account.id === args.accountId ? args.change(account) : account,
      ),
    }))
  }

  /**
   * Serialised in process and re-read from disk inside the lock, so a refresh landing while the
   * operator adds an account keeps both. Two Atlas processes writing in the same instant still race;
   * `adoptionOf` is what stops that race from replacing a newer credential with an older one.
   */
  private async mutate(change: (vault: VaultFile) => VaultFile): Promise<void> {
    const queued = this.writes.then(async () => {
      const next = change(this.load())
      this.write(next)
    })

    this.writes = queued.catch(() => undefined)
    await queued
  }

  private write(vault: VaultFile): void {
    mkdirSync(dirname(this.file), { recursive: true })

    const temporary = join(dirname(this.file), `.${randomUUID()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(vault, null, 2)}\n`, { mode: OWNER_ONLY })
    renameSync(temporary, this.file)
  }
}

const withoutSecret = ({ secret: _sealed, ...account }: SealedAccount): Account => account

const serialise = (secret: AccountSecret): string => JSON.stringify(secret)
