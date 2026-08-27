import { ToolDefinition } from '@dltech/atlas-core'

import { portToken, resolveSet, type DependencyContainer } from '../container/injection'
import { BashTool } from './builtin/bash'
import { EditTool } from './builtin/edit'
import { GlobTool } from './builtin/glob'
import { GrepTool } from './builtin/grep'
import { ReadTool } from './builtin/read'
import { WriteTool } from './builtin/write'
import { createToolRegistry, ToolRegistry } from './registry'

export function registerBuiltinTools({ container }: { container: DependencyContainer }): void {
  container.register(portToken(ToolDefinition), { useClass: ReadTool })
  container.register(portToken(ToolDefinition), { useClass: WriteTool })
  container.register(portToken(ToolDefinition), { useClass: EditTool })
  container.register(portToken(ToolDefinition), { useClass: BashTool })
  container.register(portToken(ToolDefinition), { useClass: GrepTool })
  container.register(portToken(ToolDefinition), { useClass: GlobTool })

  container.register(portToken(ToolRegistry), {
    useFactory: (resolver) =>
      createToolRegistry(resolveSet({ container: resolver, token: portToken(ToolDefinition) })),
  })
}
