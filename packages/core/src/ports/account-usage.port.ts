import type { AccountId } from '../credentials/account'
import type { AccountUsage } from '../usage/window'

export type AccountUsageRequest = { accountId?: AccountId | undefined }

export abstract class AccountUsagePort {
  abstract read(request?: AccountUsageRequest): Promise<AccountUsage | null>
}
