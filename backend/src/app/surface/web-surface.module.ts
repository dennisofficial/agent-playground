import { Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { AgentSessionManager } from '../brain/agent-session-manager.service';
import { DecisionApprovalService } from '../brain/decision-approval.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { GitModule } from '../git/git.module';
import { MessageEntity, RepoEntity, JobEntity } from '../persistence/entities';
import { WebSurface } from './web-surface';
import {
  AMEND_APPROVE_ACTION_ID,
  AMEND_DISMISS_ACTION_ID,
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  RETRACT_SHIP_ACTION_ID,
  SHIP_ACTION_ID,
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
  imports: [
    TypeOrmModule.forFeature(
      [JobEntity, MessageEntity, RepoEntity],
      DB_CONNECTION,
    ),
    // Repo-file endpoints need `LocalGitService` (git ls-files over the job worktree); GitModule is not
    // `@Global`, so it must be imported for the injected service to resolve.
    GitModule,
  ],
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
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    this.approvalSub = this.surface.approval$.subscribe(({ actionId, value, ruledBy, note }) => {
      const meta = parseWebApprovalMeta(value);
      if (!meta) return;

      // SHIP-REVIEW gate: not a plan verdict — resume the driver so it re-reaches `finalizeBuild` and ships.
      // Resolved lazily via ModuleRef (the surface must not import the driver — that would form a cycle,
      // DriverModule already depends on the surface for CHAT_SURFACE). Idempotent: `resolveShipApprovalDurably`
      // only acts while the job is `awaiting_ship_review`, so a stale/double click is a no-op.
      if (actionId === SHIP_ACTION_ID) {
        void resolveShipApproval(this.moduleRef, meta.jobId, ruledBy).catch(() => undefined);
        return;
      }

      // RETRACT the ship-review gate: the "Back to building" click. Same lazy-driver resolution as the
      // approve branch above; `retractShipDurably` is idempotent (acts only while parked), so a stale click
      // is a safe no-op.
      if (actionId === RETRACT_SHIP_ACTION_ID) {
        void retractShip(this.moduleRef, meta.jobId, ruledBy).catch(() => undefined);
        return;
      }

      // APPROVE the brain's "Amend build?" proposal: run the SAME operator retract path (so the retract note
      // is operator-authored, never "Operator wants…"), neutralize the proposal card, and — only if the
      // retract actually fired — wake the brain to do the follow-up work. Idempotent throughout.
      if (actionId === AMEND_APPROVE_ACTION_ID) {
        void amendApprove(this.moduleRef, this.asm, meta.jobId, ruledBy).catch(() => undefined);
        return;
      }

      // DISMISS the brain's amend proposal: just neutralize the card. The gate stays parked at ship-review.
      if (actionId === AMEND_DISMISS_ACTION_ID) {
        void neutralizeAmendProposal(
          this.moduleRef,
          meta.jobId,
          'Dismissed — staying at ship review.',
        ).catch(() => undefined);
        return;
      }

      const verdict = actionIdToVerdict(actionId);
      if (!verdict) return;

      const resolved = this.approvals.resolve(meta.jobId, verdict, ruledBy, note, meta.decisionRecordId);
      if (!resolved) {
        // No LIVE in-memory handle. Either a genuinely stale/double click, OR the in-memory pending map
        // was dropped by a restart while the thread stayed durably `awaiting_approval` (the documented
        // durability gap). Fall back to the restart-safe durable resolver, which acts only if the job is
        // still awaiting — so a true stale click remains a no-op. Fire-and-forget; errors are logged.
        void this.asm
          .resolveApprovalDurably(meta.jobId, verdict, ruledBy, note, meta.decisionRecordId)
          .catch(() => undefined);
      }
    });
  }

  onApplicationShutdown(): void {
    this.approvalSub?.unsubscribe();
  }
}

/**
 * Resume a ship-review gate approval. Lazily imports {@link ThreadDriver} (a dynamic import keeps the
 * surface⇄driver dependency out of module load — mirrors how the driver resolves the brain) and resolves
 * it from the app-wide DI graph. `resolveShipApprovalDurably` is itself idempotent (acts only while the
 * job is `awaiting_ship_review`), so a stale/double click is a safe no-op.
 */
async function resolveShipApproval(
  moduleRef: ModuleRef,
  jobId: string,
  ruledBy: string,
): Promise<void> {
  const { ThreadDriver } = await import('../driver/thread-driver.service.js');
  const driver = moduleRef.get(ThreadDriver, { strict: false });
  await driver.resolveShipApprovalDurably(jobId, ruledBy);
}

/**
 * Retract a ship-review gate back to planning. Mirrors {@link resolveShipApproval}'s lazy `ThreadDriver`
 * resolution; `retractShipDurably` is itself idempotent (acts only while `awaiting_ship_review`).
 */
async function retractShip(
  moduleRef: ModuleRef,
  jobId: string,
  ruledBy: string,
): Promise<void> {
  const { ThreadDriver } = await import('../driver/thread-driver.service.js');
  const driver = moduleRef.get(ThreadDriver, { strict: false });
  await driver.retractShipDurably(jobId, ruledBy);
}

/**
 * APPROVE the brain's "Amend build?" proposal. Runs the operator retract path (attributed to `ruledBy`),
 * neutralizes the durable proposal card either way, and wakes the brain ONLY if the retract actually fired
 * (a stale click — the operator already shipped/retracted — returns false, so no spurious wake). Lazy
 * `ThreadDriver`/`DriverStoreService` resolution mirrors {@link retractShip}.
 */
async function amendApprove(
  moduleRef: ModuleRef,
  asm: AgentSessionManager,
  jobId: string,
  ruledBy: string,
): Promise<void> {
  const { ThreadDriver } = await import('../driver/thread-driver.service.js');
  const { DriverStoreService } = await import('../driver/driver-store.service.js');
  const driver = moduleRef.get(ThreadDriver, { strict: false });
  const store = moduleRef.get(DriverStoreService, { strict: false });
  const acted = await driver.retractShipDurably(jobId, ruledBy);
  await store.neutralizeAmendProposal(jobId, 'Approved — amending the build.');
  if (acted) await asm.wakeForAmendApproved(jobId);
}

/**
 * Neutralize the brain's amend proposal card without touching the gate — the Dismiss path. Lazy
 * `DriverStoreService` resolution mirrors {@link retractShip}.
 */
async function neutralizeAmendProposal(
  moduleRef: ModuleRef,
  jobId: string,
  verdictLine: string,
): Promise<void> {
  const { DriverStoreService } = await import('../driver/driver-store.service.js');
  const store = moduleRef.get(DriverStoreService, { strict: false });
  await store.neutralizeAmendProposal(jobId, verdictLine);
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
