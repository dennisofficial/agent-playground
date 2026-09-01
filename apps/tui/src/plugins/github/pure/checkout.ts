import { EForge, forgeOfHost, parseRemoteUrl, type RemoteRepository } from './remote-url'

export { EForge } from './remote-url'
export type { RemoteRepository } from './remote-url'

export type NamedRemote = { name: string; url: string }

export type RepositoryCheckout = {
  directory: string
  branch: string
  forge: EForge
  remote: RemoteRepository
}

export const checkoutKey = (checkout: RepositoryCheckout): string =>
  `${checkout.remote.host}/${checkout.remote.owner}/${checkout.remote.repo}#${checkout.branch}`

const PREFERRED_REMOTES = ['origin', 'upstream'] as const

const remoteOf = (remotes: readonly NamedRemote[]): RemoteRepository | null => {
  for (const name of PREFERRED_REMOTES) {
    const named = remotes.find((remote) => remote.name === name)
    if (named === undefined) continue

    const parsed = parseRemoteUrl({ url: named.url })
    if (parsed !== null) return parsed
  }

  for (const remote of remotes) {
    const parsed = parseRemoteUrl({ url: remote.url })
    if (parsed !== null) return parsed
  }

  return null
}

export function checkoutOf(args: {
  directory: string
  branch: string
  remotes: readonly NamedRemote[]
}): RepositoryCheckout | null {
  if (args.branch.length === 0) return null

  const remote = remoteOf(args.remotes)
  if (remote === null) return null

  return {
    directory: args.directory,
    branch: args.branch,
    forge: forgeOfHost({ host: remote.host }),
    remote,
  }
}
