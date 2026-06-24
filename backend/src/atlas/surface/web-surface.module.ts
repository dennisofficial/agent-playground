import { Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { DecisionApprovalService } from '../brain/decision-approval.service';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasMessage, AtlasThread } from '../persistence/entities';
import { AtlasWebSurface } from './atlas-web-surface';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
} from './approval-blocks';
import { parseWebApprovalMeta } from './web-approval-card';
import { WebSurfaceController } from './web-surface.controller';
import type { ApprovalVerdict } from '../brain/decision-approval.service';

/**
 * R0 — WEB SURFACE MODULE. Provides `AtlasWebSurface` + the `WebSurfaceController` HTTP/SSE edge,
 * and wires the approval-click control channel WITHOUT a circular dep:
 *
 *  - `AtlasWebSurface.approval$` emits when the web client clicks an approval button.
 *  - This module subscribes to `approval$` in `onApplicationBootstrap` and calls
 *    `DecisionApprovalService.resolve` — the surface never imports the brain.
 *  - `DecisionApprovalService` lives in `BrainModule` which is `@Global`, so it resolves ambiently.
 *
 * Circular-dep safety: `AtlasWebSurface` imports nothing from `brain/`; `DecisionApprovalService`
 * imports `CHAT_SURFACE` (provided by `SurfaceModule`); `WebSurfaceModule` is imported BY
 * `SurfaceModule` only in the `web` branch. The flow is:
 *   WebSurfaceController → AtlasWebSurface → approval$ → (this module's subscriber)
 *   → DecisionApprovalService.resolve()   [no back edge into WebSurface]
 *
 * Zero v1 imports.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AtlasThread, AtlasMessage], ATLAS_CONNECTION)],
  providers: [AtlasWebSurface],
  controllers: [WebSurfaceController],
  exports: [AtlasWebSurface],
})
export class WebSurfaceModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private approvalSub?: Subscription;

  constructor(
    private readonly surface: AtlasWebSurface,
    private readonly approvals: DecisionApprovalService,
  ) {}

  onApplicationBootstrap(): void {
    this.approvalSub = this.surface.approval$.subscribe(({ actionId, value, ruledBy, note }) => {
      const meta = parseWebApprovalMeta(value);
      if (!meta) return;

      const verdict = actionIdToVerdict(actionId);
      if (!verdict) return;

      const resolved = this.approvals.resolve(meta.jobId, verdict, ruledBy, note);
      if (!resolved) {
        // Stale click (double-click, already resolved, or no pending gate) — silently drop.
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
