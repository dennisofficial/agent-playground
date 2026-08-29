import type { OauthTokens } from '@dltech/atlas-core'

/**
 * The store an imported credential came from. Refreshing rotates the refresh token, so a pair Atlas
 * took from another tool's store is dead in that tool the moment Atlas refreshes it — unless the new
 * pair goes back the way it came.
 */
export interface CredentialSink {
  readonly id: string
  read(): Promise<OauthTokens | undefined>
  write(tokens: OauthTokens): Promise<void>
}

export const sinkFor = (args: {
  sinks: readonly CredentialSink[]
  importedFrom: string | undefined
}): CredentialSink | undefined =>
  args.importedFrom === undefined
    ? undefined
    : args.sinks.find((sink) => sink.id === args.importedFrom)
