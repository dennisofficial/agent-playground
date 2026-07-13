import { Inject, Injectable } from '@nestjs/common';
import { findLifecycleRule, operatorMessageRules, type JitFireCtx } from '../prompt-kit/jit';
import type { TurnChunk } from '../prompt-kit/harness';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';

/** The lifecycle events this executor knows how to fire (mirrors `JitTrigger`'s `'lifecycle'` variant). */
export type JitLifecycleEvent = 'preview-requested' | 'plan-approved';

/** The dynamic per-fire data a lifecycle caller supplies — where to seed, and for whom. */
export type JitLifecycleFireCtx = {
  repoId: string;
  jobId: string;
  orgId?: string;
  /**
   * Seed onto THIS surface instead of the ambiently-bound `CHAT_SURFACE`. A caller that already holds its
   * own concrete surface (e.g. `WebSurfaceController`'s directly-injected `WebSurface`) passes it here so
   * the seed lands in the exact same place a hand-rolled `seedSystemNotification` call would have — the
   * bound `CHAT_SURFACE` can differ (e.g. the in-process agent surface in tests/tooling).
   */
  surface?: ChatSurface;
  /** The committed build path (lifecycle:plan-approved) — which branch `dispatch_build` will take. */
  buildPath?: 'direct' | 'plan';
  /** The base branch to rebase-check against (lifecycle:plan-approved). */
  baseBranch?: string;
  /** The approved decision record id (lifecycle:plan-approved) — seeds the once-per-approval dedup key. */
  decisionRecordId?: string;
  /** The repo's stored preview recipe (lifecycle:preview-requested) — spliced into the seed's managed block. */
  previewInstructions?: string | null;
};

/**
 * The HOST-SIDE JIT executor (Pillar 4) — the half of the content/wiring split that fires `lifecycle`-trigger
 * rules from the catalog (`findLifecycleRule`). A caller (e.g. `spinUpPreview`) owns WHEN to fire (its own
 * gating/idempotency); this executor owns HOW: look up the enabled rule, render its payload, and seed it as a
 * `host-seed-notice` turn with the rule's declared seed row — so the visible transcript row and the dedup
 * `chunkKey` stay exactly what the rule declares, not re-derived at each call site.
 */
@Injectable()
export class JitHostExecutor {
  constructor(@Inject(CHAT_SURFACE) private readonly surface: ChatSurface) {}

  /**
   * Fire the enabled lifecycle rule for `event`, seeding its rendered payload into `ctx.jobId`'s thread (on
   * `ctx.surface` when given, else the ambient `CHAT_SURFACE`). Returns the seeded row's ts, or `''` when no
   * matching rule fires (disabled/undeclared) or the target surface can't seed.
   */
  fireLifecycle(event: JitLifecycleEvent, ctx: JitLifecycleFireCtx): string {
    const rule = findLifecycleRule(event);
    if (!rule || rule.delivery !== 'host-seed-notice' || !rule.seed) return '';
    const fireCtx: JitFireCtx = {
      jobId: ctx.jobId,
      ...(ctx.buildPath !== undefined ? { buildPath: ctx.buildPath } : {}),
      ...(ctx.baseBranch !== undefined ? { baseBranch: ctx.baseBranch } : {}),
      ...(ctx.decisionRecordId !== undefined ? { decisionRecordId: ctx.decisionRecordId } : {}),
      ...(ctx.previewInstructions !== undefined ? { previewInstructions: ctx.previewInstructions } : {}),
    };
    const body = rule.render(fireCtx);
    const surface = ctx.surface ?? this.surface;
    return (
      surface.seedSystemNotification?.(ctx.repoId, ctx.jobId, body, {
        ...(ctx.orgId !== undefined ? { orgId: ctx.orgId } : {}),
        seedRow: { label: rule.seed.label ?? rule.id, chunkKey: rule.seed.chunkKey(fireCtx) },
      }) ?? ''
    );
  }

  /**
   * The `operator-message` turn-prefix rail (d18), rendered as `TurnChunk`s ready to prepend to a composed
   * operator turn. Every enabled rule's default render is empty (the reserved `memory` slot the follow-up
   * recall job fills) — an empty render yields NO chunk, so an operator turn with no rail content stays
   * byte-identical to the pre-JIT framing. `ctx.prependText` is threaded straight through once the recall
   * job populates it.
   */
  collectOperatorPrepends(ctx: { jobId?: string; prependText?: string }): TurnChunk[] {
    const chunks: TurnChunk[] = [];
    for (const rule of operatorMessageRules()) {
      if (rule.delivery !== 'turn-prefix') continue; // only turn-prefix rules render as prepend chunks (mirrors fireLifecycle's delivery guard)
      const fireCtx: JitFireCtx = {
        ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}),
        ...(ctx.prependText !== undefined ? { prependText: ctx.prependText } : {}),
      };
      const body = rule.render(fireCtx);
      if (!body) continue; // empty render (default no-op memory rail) → no prefix chunk → byte-identical
      chunks.push({ kind: 'system_reminder', body, attrs: { reminderKind: rule.reminderKind ?? 'memory' } });
    }
    return chunks;
  }

  /** True when the declarative catalog currently enables at least one operator turn-prefix rule. */
  hasEnabledOperatorPrepends(): boolean {
    return operatorMessageRules().some((rule) => rule.delivery === 'turn-prefix');
  }
}
