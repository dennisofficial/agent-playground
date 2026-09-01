import {
  ClockPort,
  EDefinitionOrigin,
  EventLogPort,
  IdPort,
  WorkspacePort,
} from '@dltech/atlas-core'
import {
  portToken,
  projectPluginsDirectory,
  resolveSet,
  userPluginsDirectory,
  type DependencyContainer,
} from '@dltech/atlas-harness'

import { loadPluginDirectory } from './directory-source'
import { installPluginApi } from './install-api'
import {
  loadPlugins,
  type LoadedPlugins,
  type OriginatedPlugin,
  type PluginIdentity,
} from './load'
import { registerNativePlugins } from './manifest.generated'
import { NativePlugin, type PluginHost } from './plugin'
import type { LoadedRepoPlugin, RepoPluginRefusal } from './validate'

// `origin` is a two-member union, and TypeScript will not distribute it across the object literal,
// so a spread widens `OriginatedPlugin` instead of narrowing it. The ternary is what keeps it exact.
const originated = (entry: LoadedRepoPlugin): OriginatedPlugin =>
  entry.origin === EDefinitionOrigin.User
    ? { origin: EDefinitionOrigin.User, plugin: entry.plugin }
    : { origin: EDefinitionOrigin.Project, plugin: entry.plugin }

async function repoPlugins(args: {
  cwd: string
}): Promise<{ plugins: readonly OriginatedPlugin[]; refusals: readonly RepoPluginRefusal[] }> {
  const reads = await Promise.all([
    loadPluginDirectory({ directory: userPluginsDirectory(), origin: EDefinitionOrigin.User }),
    loadPluginDirectory({
      directory: projectPluginsDirectory(args.cwd),
      origin: EDefinitionOrigin.Project,
    }),
  ])

  return {
    plugins: reads.flatMap((read) => read.plugins.map(originated)),
    refusals: reads.flatMap((read) => read.refusals),
  }
}

/**
 * A native that cannot be constructed is a binding the composition root forgot, not a plugin to be
 * quietly dropped — the same contract `worktree-tool-wiring.spec.ts` holds for tools. So this throws
 * rather than refusing, and only re-labels the failure, because tsyringe's own message names the
 * missing token but never says a plugin was what wanted it.
 */
function constructNatives(args: { container: DependencyContainer }): readonly OriginatedPlugin[] {
  try {
    return resolveSet({ container: args.container, token: portToken(NativePlugin) }).map(
      (plugin): OriginatedPlugin => ({ origin: EDefinitionOrigin.BuiltIn, plugin }),
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `a native plugin could not be constructed, so a dependency it injects is unbound at this point in composeAtlas: ${detail}`,
    )
  }
}

export type AssembledPlugins = LoadedPlugins & { unreadable: readonly RepoPluginRefusal[] }

/**
 * Loading happens before the first `ToolRegistry` or `HookChain` resolve. Both are cached on first
 * resolve, so a plugin registered after either one is silently absent rather than late.
 */
export async function assemblePlugins(args: {
  container: DependencyContainer
  cwd: string
  atlasHome: string
}): Promise<AssembledPlugins> {
  installPluginApi()
  registerNativePlugins({ container: args.container })

  const natives = constructNatives({ container: args.container })
  const fromDisk = await repoPlugins({ cwd: args.cwd })

  const host = (identity: PluginIdentity): PluginHost => ({
    id: identity.id,
    origin: identity.origin,
    projectDirectory: args.cwd,
    atlasHome: args.atlasHome,
    log: args.container.resolve(portToken(EventLogPort)),
    workspace: args.container.resolve(portToken(WorkspacePort)),
    clock: args.container.resolve(portToken(ClockPort)),
    ids: args.container.resolve(portToken(IdPort)),
  })

  const loaded = await loadPlugins({
    plugins: [...natives, ...fromDisk.plugins],
    host,
    container: args.container,
  })

  return { ...loaded, unreadable: fromDisk.refusals }
}
