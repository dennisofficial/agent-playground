import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLogPort, EWebSearchBackend } from '@dltech/atlas-core'
import { createHarnessContainer } from './src/container/create-harness-container'
import { portToken } from './src/container/injection'
import { HookChainToken, WebSearchBackendToken, WorktreeDirectoryToken, WorkspaceRoot } from './src/container/tokens'

const container = createHarnessContainer()
container.register(WorkspaceRoot, { useValue: mkdtempSync(join(tmpdir(), 'x-')) })
container.register(WorktreeDirectoryToken, { useValue: () => '.atlas/worktrees' })
container.register(WebSearchBackendToken, { useValue: () => EWebSearchBackend.DuckDuckGo })

const chain = container.resolve(HookChainToken)
console.log('beforeTool', chain.beforeTool.map((h) => h.name))
console.log('afterTool', chain.afterTool.map((h) => h.name))
console.log('beforeTurn', chain.beforeTurn.map((h) => h.name))
console.log('afterTurn', chain.afterTurn.map((h) => h.name))
