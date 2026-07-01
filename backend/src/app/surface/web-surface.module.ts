import { Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { AgentSessionManager } from '../brain/agent-session-manager.service';
import { DecisionApprovalService } from '../brain/decision-approval.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { MessageEntity, RepoEntity, JobEntity } from '../persistence/entities';
import { WebSurface } from './web-surface';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
} from './approval-blocks';
import { parseWebApprovalMeta } from './web-approval-card';
import { WebSurfaceController } from './web-surface.controller';
import { JobTitleService } from './job-title.service';
import type { ApprovalVerdict } from '../brain/decision-approval.service';

/**
 * R0 — WEB SURFACE MODULE. Provides `WebSurface` + the `WebSurfaceController` HTTP/SSE edge,
 * and wires the approval-click control channel WITHOUT a circular dep:
 *
 *  - `WebSurface.approval$` emits when the web client clicks an approval button.
 *  - This module subscribes to `approval$` in `onApplicationBootstrap` and calls
 *    `DecisionApprovalService.resolve` — the surface never imports the brain. When no live in-memory
 *    handle exists (e.g. a restart dropped it), it falls back to `AgentSessionManager.resolveApprovalDurably`
 *    so the gate still resolves from durable state. Both are resolved ambiently from the `@Global` BrainModule.
 *  - `DecisionApprovalService` lives in `BrainModule` which is `@Global`, so it resolves ambiently.
 *
 * Circular-dep safety: `WebSurface` imports nothing from `brain/`; `DecisionApprovalService`
 * imports `CHAT_SURFACE` (provided by `SurfaceModule`); `WebSurfaceModule` is imported BY
 * `SurfaceModule` only in the `web` branch. The flow is:
 *   WebSurfaceController → WebSurface → approval$ → (this module's subscriber)
 *   → DecisionApprovalService.resolve()   [no back edge into WebSurface]
 *
 * Zero v1 imports.
 */
@Module({
  imports: [TypeOrmModule.forFeature([JobEntity, MessageEntity, RepoEntity], DB_CONNECTION)],
  providers: [
    WebSurface,
    // `JobTitleService` injects `JOB_TITLE_CHAIN`, now provided by the `@Global` `TitlingModule`.
    JobTitleService,
  ],
  controllers: [WebSurfaceController],
  exports: [WebSurface],
})
export class WebSurfaceModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private approvalSub?: Subscription;

  constructor(
    private readonly surface: WebSurface,
    private readonly approvals: DecisionApprovalService,
    private readonly asm: AgentSessionManager,
  ) {}

  onApplicationBootstrap(): void {
    this.approvalSub = this.surface.approval$.subscribe(({ actionId, value, ruledBy, note }) => {
      const meta = parseWebApprovalMeta(value);
      if (!meta) return;

      const verdict = actionIdToVerdict(actionId);
      if (!verdict) return;

      const resolved = this.approvals.resolve(meta.jobId, verdict, ruledBy, note);
      if (!resolved) {
        // No LIVE in-memory handle. Either a genuinely stale/double click, OR the in-memory pending map
        // was dropped by a restart while the thread stayed durably `awaiting_approval` (the documented
        // durability gap). Fall back to the restart-safe durable resolver, which acts only if the job is
        // still awaiting — so a true stale click remains a no-op. Fire-and-forget; errors are logged.
        void this.asm.resolveApprovalDurably(meta.jobId, verdict, ruledBy, note).catch(() => undefined);
      }
    });
  }

  onApplicationShutdown(): void {
    this.approvalSub?.unsubscribe();
  }
}

function actionIdToVerdict(actionId: string): ApprovalVerdict | undefined {
  switch (actionId) {
    case APPROVE_ACTION_ID:
      return 'approve';
    case REQUEST_CHANGES_ACTION_ID:
      return 'request_changes';
    case DENY_ACTION_ID:
      return 'deny';
    default:
      return undefined;
  }
}
