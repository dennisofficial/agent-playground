import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import {
  AfterShellHook,
  ClockPort,
  EStage,
  toThreadId,
  type EndedShell,
  type HookOrder,
  type HookOutcome,
} from '@dltech/atlas-core'

import { resolveHookChain } from '../../hooks/resolve-hooks'
import { registerShells } from '../../shells/register-shells'
import { ShellRegistryPort } from '../../shells/shell-registry'
import {
  createIsolatedContainer,
  instanceCachingFactory,
  portToken,
  type DependencyContainer,
} from '../injection'
import { HookChainToken, WorkspaceRoot } from '../tokens'

class FixedClock extends ClockPort {
  now(): string {
    return '2026-08-27T12:00:00.000Z'
  }
}

const THREAD = toThreadId('thread-under-test')

const fired: EndedShell[] = []

/**
 * The cycle, in one class: a hook that reaches back into the registry that fires it. Resolving
 * either end eagerly would recurse, so the registry holds the chain as a thunk.
 */
class ListingAfterShellHook extends AfterShellHook {
  readonly name = 'list-shells-when-one-ends'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  constructor(private readonly shells: ShellRegistryPort) {
    super()
  }

  readonly run = async ({ shell }: { shell: EndedShell }): Promise<HookOutcome> => {
    fired.push(shell)
    return { additionalContext: `${this.shells.listEverywhere().length} shells are known` }
  }
}

const opened: { container: DependencyContainer; root: string }[] = []

afterEach(async () => {
  fired.splice(0)
  for (const entry of opened.splice(0)) {
    await entry.container.resolve(portToken(ShellRegistryPort)).closeAll()
    rmSync(entry.root, { recursive: true, force: true })
  }
})

function openContainer(): { container: DependencyContainer; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'atlas-shell-cycle-'))
  const container = createIsolatedContainer()
  container.register(WorkspaceRoot, { useValue: root })
  container.register(portToken(AfterShellHook), {
    useFactory: (resolver) =>
      new ListingAfterShellHook(resolver.resolve(portToken(ShellRegistryPort))),
  })
  container.register(portToken(ClockPort), { useClass: FixedClock })

  registerShells({ container })
  container.register(HookChainToken, {
    useFactory: instanceCachingFactory((resolver) => resolveHookChain({ container: resolver })),
  })

  const entry = { container, root }
  opened.push(entry)
  return entry
}

describe('the shell registry and the hook chain, in a real container', () => {
  it('resolves both ends of the cycle without recursing', () => {
    const { container } = openContainer()

    const shells = container.resolve(portToken(ShellRegistryPort))
    const chain = container.resolve(HookChainToken)

    expect(shells).toBe(container.resolve(portToken(ShellRegistryPort)))
    expect(chain).toBe(container.resolve(HookChainToken))
  })

  it('reaches a hook that depends on the registry firing it', async () => {
    const { container } = openContainer()
    const shells = container.resolve(portToken(ShellRegistryPort))

    const started = shells.start({
      threadId: THREAD,
      command: 'echo wired',
      description: 'Prove the wiring',
    })
    if (!started.ok) throw new Error(started.reason)

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (shells.pendingNotices({ threadId: THREAD }).length > 0) break
      await Bun.sleep(25)
    }

    expect(fired.map((shell) => shell.command)).toEqual(['echo wired'])
    expect(shells.drainNotifications({ threadId: THREAD })).toHaveLength(2)
  })
})
