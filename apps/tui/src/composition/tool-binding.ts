import type { ToolDeclaration } from '@dltech/atlas-core'
import {
  createBashTool,
  createBoundaryHook,
  createDispatch,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createHookRegistry,
  createReadTool,
  createToolRegistry,
  createWriteTool,
  type Dispatch,
} from '@dltech/atlas-harness'

export type ToolBinding = { dispatch: Dispatch; declarations: readonly ToolDeclaration[] }

export function bindTools({ root }: { root: string }): ToolBinding {
  const registry = createToolRegistry([
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool({ root }),
    createGrepTool({ root }),
    createGlobTool({ root }),
  ])

  const hooks = createHookRegistry({ beforeTool: [createBoundaryHook({ root })] })

  return { dispatch: createDispatch({ registry, hooks }), declarations: registry.declarations() }
}
