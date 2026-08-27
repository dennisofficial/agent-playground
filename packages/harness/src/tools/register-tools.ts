import { ToolDefinition } from '@dltech/atlas-core'

import { portToken, type DependencyContainer } from '../container/injection'
import { BashTool } from './builtin/bash'
import { EditTool } from './builtin/edit'
import { GlobTool } from './builtin/glob'
import { GrepTool } from './builtin/grep'
import { ReadTool } from './builtin/read'
import { ShellKillTool } from './builtin/shell-kill'
import { ShellListTool } from './builtin/shell-list'
import { ShellOutputTool } from './builtin/shell-output'
import { WriteTool } from './builtin/write'
import { InMemoryToolRegistry, ToolRegistry } from './registry'

export function registerBuiltinTools({ container }: { container: DependencyContainer }): void {
  container.register(portToken(ToolDefinition), { useClass: ReadTool })
  container.register(portToken(ToolDefinition), { useClass: WriteTool })
  container.register(portToken(ToolDefinition), { useClass: EditTool })
  container.register(portToken(ToolDefinition), { useClass: BashTool })
  container.register(portToken(ToolDefinition), { useClass: GrepTool })
  container.register(portToken(ToolDefinition), { useClass: GlobTool })
  container.register(portToken(ToolDefinition), { useClass: ShellListTool })
  container.register(portToken(ToolDefinition), { useClass: ShellOutputTool })
  container.register(portToken(ToolDefinition), { useClass: ShellKillTool })

  container.register(portToken(ToolRegistry), { useClass: InMemoryToolRegistry })
}
