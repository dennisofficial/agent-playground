import { registerDisposable } from '../container/disposal'
import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
import { BunShellRegistry, ShellRegistryPort } from './shell-registry'

export function registerShells({ container }: { container: DependencyContainer }): void {
  let live: ShellRegistryPort | undefined

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
