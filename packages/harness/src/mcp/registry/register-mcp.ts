import { BeforeTurnHook, DynamicToolSource } from '@dltech/atlas-core'

import { registerDisposable } from '../../container/disposal'
import { portToken, type DependencyContainer } from '../../container/injection'
import { BuiltInMcpSource, CompatMcpSource, FileMcpSource, resolveMcpSpecs } from '../config'
import { TrustResolver } from '../bridge/trust-resolver'
import { HandleStore } from '../bridge/handle-store'
import { McpInstructionsHook } from '../instructions/instructions-hook'
import { McpHandleTrust } from './workspace-boundary-hook'

export async function registerMcp(args: {
  container: DependencyContainer
  cwd: string
}): Promise<HandleStore> {
  const resolved = await resolveMcpSpecs({
    sources: [
      new BuiltInMcpSource(),
      FileMcpSource.user(),
      FileMcpSource.project({ cwd: args.cwd }),
      new CompatMcpSource({ cwd: args.cwd }),
    ],
  })

  const store = new HandleStore({ specs: resolved.specs })
  await store.connectAll()

  args.container.register(portToken(DynamicToolSource), { useValue: store })
  args.container.register(portToken(McpHandleTrust), { useValue: new TrustResolver({ store }) })
  args.container.register(portToken(BeforeTurnHook), { useValue: new McpInstructionsHook({ store }) })
  registerDisposable({ container: args.container, close: () => store.closeAll() })

  return store
}
