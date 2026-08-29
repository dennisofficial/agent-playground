import { randomUUID } from 'node:crypto'

import {
  AccountStorePort,
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

import { SecretCipher } from './secret-cipher'
import {
  cipherSecretBox,
  fileVaultBackend,
  memoryVaultBackend,
  plainSecretBox,
  type SecretBox,
  type VaultBackend,
} from './vault-backend'
import type { SealedAccount, VaultFile } from './vault-file'

const withoutSecret = ({ secret: _sealed, ...account }: SealedAccount): Account => account

export class AccountStore extends AccountStorePort {
  private readonly backend: VaultBackend
  private readonly box: SecretBox
  private readonly clock: ClockPort
  private writes: Promise<unknown> = Promise.resolve()

  constructor(args: { backend: VaultBackend; box: SecretBox; clock: ClockPort }) {
    super()
    this.backend = args.backend
    this.box = args.box
    this.clock = args.clock
  }

  async list(): Promise<readonly Account[]> {
    return this.backend.load().accounts.map(withoutSecret)
  }

  async read(accountId: AccountId): Promise<StoredAccount | undefined> {
    const sealed = this.backend.load().accounts.find((account) => account.id === accountId)
    if (sealed === undefined) return undefined

    return { ...sealed, secret: this.box.open(sealed.secret) }
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
    const sealed = this.box.seal(draft.secret)

    await this.mutate((vault) => ({
      ...vault,
      accounts: [...vault.accounts, { ...account, secret: sealed }],
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
    const sealed = this.box.seal(args.secret)

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
    return this.backend.load().active[provider]
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
   * Serialised in process and re-read from the backend inside the lock, so a refresh landing while
   * the operator adds an account keeps both. Two Atlas processes writing in the same instant still
   * race; `adoptionOf` is what stops that race replacing a newer credential with an older one.
   */
  private async mutate(change: (vault: VaultFile) => VaultFile): Promise<void> {
    const queued = this.writes.then(async () => {
      this.backend.save(change(this.backend.load()))
    })

    this.writes = queued.catch(() => undefined)
    await queued
  }
}

export const fileAccountStore = (args: {
  file: string
  keyFile: string
  clock: ClockPort
}): AccountStore =>
  new AccountStore({
    backend: fileVaultBackend(args.file),
    box: cipherSecretBox({ cipher: new SecretCipher(args.keyFile), where: args.file }),
    clock: args.clock,
  })

export const memoryAccountStore = (args: { clock: ClockPort }): AccountStore =>
  new AccountStore({ backend: memoryVaultBackend(), box: plainSecretBox(), clock: args.clock })
