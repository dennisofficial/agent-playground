/**
 * prompt-kit / message — the `AgentMessage` seam.
 *
 * `AgentMessage` is the branded/opaque type for ANY body that reaches an agent session: a system prompt, a
 * task body, a seeded harness chunk, a JIT payload. It is a plain string at runtime (so it stays zero-dep and
 * safe to bundle into the in-container engine) but carries a compile-time brand that ONLY a hub factory can
 * apply. Passing a bare string where an `AgentMessage` is required is a compile error — so the CONTENT of every
 * agent-facing message can only originate in the hub. Delivery WIRING (which service sends it, when, over which
 * channel) stays in services per the content/wiring split; those services pass an already-minted `AgentMessage`.
 *
 * Two enforcement layers use this file (see STANDARDS.md, decision d10):
 *   1. BRAND — the seam params (`RunEngineArgs.task`/`systemPrompt`, `steerUserMessage` content,
 *      `seedSystemNotification` body, the unified `recordSystemChunk` text/fullBody) take `AgentMessage`.
 *      Thread 5 flips those params to require the brand; Threads 2–4 mint as they relocate.
 *   2. LINT — `SEALED_DELIVERY_PRIMITIVES` + `SANCTIONED_SEAM_GLOBS` below are the single source of truth the
 *      Thread 5 structural spec imports to forbid standing up a NEW raw delivery path outside the hub seam.
 */

declare const AGENT_MESSAGE_BRAND: unique symbol;

/**
 * A body destined for an agent session. Opaque brand: mint it with {@link agentMessage} (the sole hub factory);
 * a bare `string` will NOT satisfy this type. Runtime value is exactly the underlying string.
 */
export type AgentMessage = string & { readonly [AGENT_MESSAGE_BRAND]: 'AgentMessage' };

/**
 * The ONE factory that mints an {@link AgentMessage}. Call it only from inside the hub (`prompt-kit/**`) — every
 * area's templates return their assembled text through it: `(ctx) => AgentMessage`. It is an identity cast at
 * runtime (no dependency, container-safe); its value is the compile-time guarantee that agent-facing content
 * was authored in the hub, not free-handed at a call site.
 */
export function agentMessage(body: string): AgentMessage {
  return body as AgentMessage;
}

/**
 * The ONE named escape hatch for a genuinely dynamic string that did not originate as hub-authored template
 * text but still has to cross a branded seam: an operator's own chat message re-emitted to the session, the
 * agent's own text (a `record_leg_handoff` body) displayed back, or a body that was already hub-composed on
 * the host and arrives as a plain string after crossing the host→container boundary (the brand is erased on
 * the wire). It is deliberately a SEPARATE, greppable name from {@link agentMessage} so every such boundary is
 * auditable — `grep fromExternal` enumerates every place non-hub-authored text enters the seam, rather than
 * that cast hiding inline. Identity cast at runtime, exactly like {@link agentMessage}.
 */
export function fromExternal(body: string): AgentMessage {
  return body as AgentMessage;
}

/**
 * The RAW session/steer constructors that could bypass the typed seam — the only calls Thread 5's structural
 * lint SEALS to the sanctioned globs below. These are NOT the delivery-wiring helpers (`seedSystemNotification`,
 * `recordSystemChunk`): those legitimately live in services and are already guarded by their `AgentMessage`
 * params. Sealing is reserved for hand-building a fresh delivery path (a raw `SDKUserMessage` steer, a direct
 * SDK `.query(`) that never crosses the brand. Matched as call-token substrings.
 */
export const SEALED_DELIVERY_PRIMITIVES = [
  'steerUserMessage(', // raw streaming-input steer (SDKUserMessage constructor)
  'Sdk.query(', // direct Claude/Codex SDK session start (`claudeSdk.query(` / `codexSdk.query(`) — the `Sdk.`
  //             qualifier keeps this from colliding with pervasive TypeORM `dataSource.query(`/`repo.query(`.
] as const;

/**
 * Where a {@link SEALED_DELIVERY_PRIMITIVES} call is allowed to live — the single readable inventory of the
 * sanctioned seam. Paths are relative to the backend package root (`backend/`). Thread 5's lint scans the
 * source tree and fails CI on a sealed call outside these globs. `jit-host-executor.ts` lands in Thread 4;
 * listing it now keeps the inventory the source of truth the later threads target.
 */
export const SANCTIONED_SEAM_GLOBS = [
  'src/app/prompt-kit/**',
  'src/app/engine/engine-core.ts',
  'src/app/brain/jit-host-executor.ts',
] as const;

/**
 * Boot-loud parity for the enforcement config itself (mirrors `validateFragments`): a misconfigured seam —
 * an empty sealed inventory, or seam globs that no longer point anywhere — would silently DISARM the
 * structural lint, so assert both are non-degenerate at boot rather than let CI go quietly green on a
 * broken guard. Pure + dependency-free; called from the JIT catalog boot-validation and re-asserted by the
 * structural spec. Throws on misconfiguration.
 */
export function assertEnforcementSeamConfigured(): void {
  if ((SEALED_DELIVERY_PRIMITIVES as readonly unknown[]).length === 0) {
    throw new Error(
      'enforcement seam misconfigured: SEALED_DELIVERY_PRIMITIVES is empty — the structural lint would seal nothing',
    );
  }
  if ((SANCTIONED_SEAM_GLOBS as readonly unknown[]).length === 0) {
    throw new Error(
      'enforcement seam misconfigured: SANCTIONED_SEAM_GLOBS is empty — every sealed call would read as a violation',
    );
  }
  for (const glob of SANCTIONED_SEAM_GLOBS) {
    if (!glob.startsWith('src/app/')) {
      throw new Error(
        `enforcement seam misconfigured: sanctioned glob ${JSON.stringify(glob)} is not under src/app/ (the lint scans src/app/**)`,
      );
    }
  }
}
