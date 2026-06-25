import { ChatAnthropic } from '@langchain/anthropic';
import { Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { DecisionApprovalService } from '../brain/decision-approval.service';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { MessageEntity, RepoEntity, ThreadEntity } from '../persistence/entities';
import { WebSurface } from './web-surface';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
} from './approval-blocks';
import { parseWebApprovalMeta } from './web-approval-card';
import { WebSurfaceController } from './web-surface.controller';
import {
  THREAD_TITLE_CHAIN,
  ThreadTitleChain,
  type ThreadTitleChainFactory,
} from './thread-title.chain';
import { ThreadTitleService } from './thread-title.service';
import type { ApprovalVerdict } from '../brain/decision-approval.service';

/**
 * R0 — WEB SURFACE MODULE. Provides `WebSurface` + the `WebSurfaceController` HTTP/SSE edge,
 * and wires the approval-click control channel WITHOUT a circular dep:
 *
 *  - `WebSurface.approval$` emits when the web client clicks an approval button.
 *  - This module subscribes to `approval$` in `onApplicationBootstrap` and calls
 *    `DecisionApprovalService.resolve` — the surface never imports the brain.
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
  imports: [TypeOrmModule.forFeature([ThreadEntity, MessageEntity, RepoEntity], DB_CONNECTION)],
  providers: [
    WebSurface,
    ThreadTitleService,
    {
      // The per-org thread-title chain factory: resolve the tenant's Anthropic key (env fallback) and
      // cache one declarative chain per key. Key-less → `undefined` (the service keeps the placeholder).
      provide: THREAD_TITLE_CHAIN,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver): ThreadTitleChainFactory => {
        const cache = new Map<string, ReturnType<typeof ThreadTitleChain.build>>();
        return async (orgId) => {
          const key = await creds.anthropicKey(orgId);
          if (!key) return undefined;
          let chain = cache.get(key);
          if (!chain) {
            chain = ThreadTitleChain.build(
              new ChatAnthropic({
                apiKey: key,
                model: ThreadTitleChain.MODEL,
                maxTokens: 32,
                temperature: 0.3,
              }),
            );
            cache.set(key, chain);
          }
          return chain;
        };
      },
    },
  ],
  controllers: [WebSurfaceController],
  exports: [WebSurface],
})
export class WebSurfaceModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private approvalSub?: Subscription;

  constructor(
    private readonly surface: WebSurface,
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
