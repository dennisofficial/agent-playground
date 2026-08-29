import {
  EAccountOrigin,
  EAuthKind,
  PROVIDER_SPECS,
  type AccountStorePort,
  type ProviderSpec,
} from '@dltech/atlas-core'

export const environmentSourceId = (variable: string): string => `environment:${variable}`

const keyIn = (args: {
  env: Record<string, string | undefined>
  spec: ProviderSpec
}): string | undefined => {
  const variable = args.spec.apiKeyVariable
  if (variable === undefined) return undefined

  const value = args.env[variable]
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * An API key in the environment is an account like any other — listed, switchable, removable — but
 * it is owned by the environment, so it appears when the variable is set and goes when it is not.
 */
export async function syncEnvironmentAccounts(args: {
  accounts: AccountStorePort
  env: Record<string, string | undefined>
}): Promise<void> {
  const stored = await args.accounts.list()

  for (const spec of PROVIDER_SPECS) {
    const variable = spec.apiKeyVariable
    if (variable === undefined) continue

    const sourceId = environmentSourceId(variable)
    const existing = stored.find(
      (account) =>
        account.origin === EAccountOrigin.Environment && account.importedFrom === sourceId,
    )
    const apiKey = keyIn({ env: args.env, spec })

    if (apiKey === undefined) {
      if (existing !== undefined) await args.accounts.remove(existing.id)
      continue
    }

    if (existing === undefined) {
      await args.accounts.add({
        provider: spec.provider,
        label: `${spec.label} (${variable})`,
        secret: { kind: EAuthKind.ApiKey, apiKey },
        origin: EAccountOrigin.Environment,
        importedFrom: sourceId,
      })
      continue
    }

    const held = await args.accounts.read(existing.id)
    const unchanged = held?.secret.kind === EAuthKind.ApiKey && held.secret.apiKey === apiKey
    if (unchanged) continue

    await args.accounts.replaceSecret({
      accountId: existing.id,
      secret: { kind: EAuthKind.ApiKey, apiKey },
    })
  }
}
