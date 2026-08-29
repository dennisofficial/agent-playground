export enum ECredentialFailure {
  StoreUnavailable = 'store-unavailable',
  NotFound = 'not-found',
  Unreadable = 'unreadable',
  Expired = 'expired',
  RefreshFailed = 'refresh-failed',
}

export class CredentialError extends Error {
  readonly failure: ECredentialFailure

  constructor(args: { failure: ECredentialFailure; message: string }) {
    super(args.message)
    this.name = 'CredentialError'
    this.failure = args.failure
  }
}
