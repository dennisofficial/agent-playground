import type {
  Account,
  AccountId,
  AccountSecret,
  EAccountStatus,
  EAuthProvider,
  StoredAccount,
} from '../credentials/account'

export type AccountDraft = {
  provider: EAuthProvider
  label: string
  secret: AccountSecret
  origin: Account['origin']
  email?: string | undefined
  subscription?: string | undefined
  importedFrom?: string | undefined
}

export abstract class AccountStorePort {
  abstract list(): Promise<readonly Account[]>
  abstract read(accountId: AccountId): Promise<StoredAccount | undefined>
  abstract add(draft: AccountDraft): Promise<Account>
  abstract replaceSecret(args: { accountId: AccountId; secret: AccountSecret }): Promise<void>
  abstract setStatus(args: { accountId: AccountId; status: EAccountStatus }): Promise<void>
  abstract remove(accountId: AccountId): Promise<void>
  abstract setActive(args: { provider: EAuthProvider; accountId: AccountId }): Promise<void>
  abstract activeFor(provider: EAuthProvider): Promise<AccountId | undefined>
}
