export class OauthHttpError extends Error {
  readonly status: number

  constructor(args: { provider: string; status: number }) {
    super(`the ${args.provider} token endpoint answered HTTP ${args.status}`)
    this.name = 'OauthHttpError'
    this.status = args.status
  }
}

export class OauthResponseError extends Error {
  constructor(detail: string) {
    super(`the token response was unusable: ${detail}`)
    this.name = 'OauthResponseError'
  }
}

/** 400, 401 and 403 mean the credential is dead; anything else means the network blipped. */
export const isHardAuthFailure = (error: unknown): boolean =>
  error instanceof OauthHttpError && [400, 401, 403].includes(error.status)
