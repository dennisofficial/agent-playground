import { registerDisposable } from '../container/disposal'
import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
import { HookChainSourceToken, HookChainToken } from '../container/tokens'
import { BunShellRegistry, ShellRegistryPort } from './shell-registry'

/**
 * The chain is bound as a thunk because the registry sits inside its own dependency graph: hooks
 * resolve tools, tools resolve this registry, and an eager binding would close that cycle. Nothing
 * reads it until a background shell ends.
 */
export function registerShells({ container }: { container: DependencyContainer }): void {
  let live: ShellRegistryPort | undefined

  container.register(HookChainSourceToken, {
    useValue: () => container.resolve(HookChainToken),
  })

  container.register(portToken(ShellRegistryPort), {
    useFactory: instanceCachingFactory((resolver) => {
      live = resolver.resolve(BunShellRegistry)
      return live
    }),
  })

  registerDisposable({
    container,
    close: async () => {
      await live?.closeAll()
    },
  })
}
