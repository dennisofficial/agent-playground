declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

/**
 * React warns about every state update that lands outside `act` while the act environment flag is
 * up, and `testRender` raises it. A real `setInterval` firing into the tree is exactly such an
 * update, so the flag comes down here and stays down: a timer that outlives the wait would warn
 * the moment it was raised again, and the renderer's own `destroy` lowers it regardless.
 */
export async function letTimersRun(args: {
  setup: { flush: () => Promise<void> }
  ms: number
}): Promise<{ elapsedMs: number }> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  const started = performance.now()
  await new Promise((resolve) => setTimeout(resolve, args.ms))
  await args.setup.flush()
  return { elapsedMs: performance.now() - started }
}
