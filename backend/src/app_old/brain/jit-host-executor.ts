import { Inject, Injectable, Optional } from '@nestjs/common';
import { TurnChunk } from '../../_shared/prompt-kit/harness/tag-vocabulary';
import {
  findLifecycleRule,
  operatorMessageRules,
  type JitFireCtx,
} from '../../_shared/prompt-kit/jit';
import { LANE_SEEDER, type LaneSeeder } from '../driver/build-lane-delivery.service';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { descriptorForLane } from '../surface/thread-registry';

export type JitLifecycleEvent = 'plan-approved';

export type JitLifecycleFireCtx = {
  repoId: string;
  jobId: string;
  orgId?: string;
  surface?: ChatSurface;
  buildPath?: 'direct' | 'plan';
  baseBranch?: string;
  decisionRecordId?: string;
  lane?: string;
};

@Injectable()
export class JitHostExecutor {
  constructor(
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    @Optional() @Inject(LANE_SEEDER) private readonly laneSeeder?: LaneSeeder,
  ) {}

  fireLifecycle(event: JitLifecycleEvent, ctx: JitLifecycleFireCtx): string {
    const rule = findLifecycleRule(event);
    if (!rule || rule.delivery !== 'host-seed-notice' || !rule.seed) return '';
    const fireCtx: JitFireCtx = {
      jobId: ctx.jobId,
      ...(ctx.buildPath !== undefined ? { buildPath: ctx.buildPath } : {}),
      ...(ctx.baseBranch !== undefined ? { baseBranch: ctx.baseBranch } : {}),
      ...(ctx.decisionRecordId !== undefined ? { decisionRecordId: ctx.decisionRecordId } : {}),
    };
    const body = rule.render(fireCtx);

    const buildLane = ctx.lane && ctx.lane !== 'main' ? descriptorForLane(ctx.lane) : null;
    if (buildLane?.descriptor.kind === 'builder') {
      const threadId = buildLane.ids[0];
      if (this.laneSeeder && ctx.orgId && threadId) {
        void this.laneSeeder.seedLane(
          { jobId: ctx.jobId, orgId: ctx.orgId, repoId: ctx.repoId, threadId },
          body,
        );
      }
      return '';
    }

    const surface = ctx.surface ?? this.surface;
    return (
      surface.seedSystemNotification?.(ctx.repoId, ctx.jobId, body, {
        ...(ctx.orgId !== undefined ? { orgId: ctx.orgId } : {}),
        ...(ctx.lane !== undefined ? { lane: ctx.lane } : {}),
        seedRow: {
          label: rule.seed.label ?? rule.id,
          chunkKey: rule.seed.chunkKey(fireCtx),
        },
      }) ?? ''
    );
  }

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
      chunks.push({
        kind: 'system_reminder',
        body,
        attrs: { reminderKind: rule.reminderKind ?? 'memory' },
      });
    }
    return chunks;
  }

  hasEnabledOperatorPrepends(): boolean {
    return operatorMessageRules().some((rule) => rule.delivery === 'turn-prefix');
  }
}
