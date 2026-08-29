import { registerGrammars } from '../grammars/index'
import { frameSettled } from '../../__tests__/waiting'

/**
 * `getTreeSitterClient()` hands back ONE client for the whole process. `renderer.destroy()` tears it
 * down, so a highlight pass still in flight rejects with `TreeSitter client destroyed` and the fence
 * it belonged to is silently drawn as plain text.
 *
 * Two things bound the damage in @opentui 0.4.5, and neither existed when the previous app hit this:
 * `destroyTreeSitterClient` drops the singleton, so the next `getTreeSitterClient()` builds a fresh
 * one rather than handing back a dead handle; and `testRender` unmounts the React root from its own
 * `onDestroy`, before the renderer finishes tearing down. What is left is the in-flight pass, which
 * `teardown` below settles before destroying anything.
 */

let registered: Promise<void> | null = null

export function grammarsReady(): Promise<void> {
  registered ??= registerGrammars()
  return registered
}

/** How long a `<code>` renderable's own highlight round trip is given to land. */
export const HIGHLIGHT_SETTLE_MS = 400

export async function settle(ms = HIGHLIGHT_SETTLE_MS): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function teardown(setup: {
  flush: () => Promise<void>
  captureCharFrame: () => string
  renderer: { destroy: () => void }
}): Promise<void> {
  await frameSettled({ setup, within: HIGHLIGHT_SETTLE_MS })
  setup.renderer.destroy()
}
