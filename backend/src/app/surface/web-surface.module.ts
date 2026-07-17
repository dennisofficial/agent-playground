import {
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { AgentSessionManager } from '../brain/agent-session-manager.service';
import { DecisionApprovalService } from '../brain/decision-approval.service';
import { DriverApprovalGateway } from '../driver-approval-gateway';
import { DB_CONNECTION } from '../persistence/database.module';
import { GitModule } from '../git/git.module';
import { JobBootstrapModule } from '../job-bootstrap';
import { StimulusModule } from '../stimulus/stimulus.module';
import {
  TranscriptMessageEntity,
  RepoEntity,
  JobEntity,
  SubagentEntity,
  ComposerDraftEntity,
  ComposerDraftAttachmentEntity,
} from '../persistence/entities';
import { WebSurface } from './web-surface';
import { ComposerDraftService } from './composer-draft.service';
import {
  AMEND_APPROVE_ACTION_ID,
  AMEND_DISMISS_ACTION_ID,
  APPROVE_ACTION_ID,
  DB_WRITE_APPROVE_ACTION_ID,
  DB_WRITE_DENY_ACTION_ID,
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
      [
        JobEntity,
        TranscriptMessageEntity,
        RepoEntity,
        SubagentEntity,
        ComposerDraftEntity,
        ComposerDraftAttachmentEntity,
      ],
      DB_CONNECTION,
    ),
    // Repo-file endpoints need `LocalGitService` (git ls-files over the job worktree); GitModule is not
    // `@Global`, so it must be imported for the injected service to resolve.
    GitModule,
    JobBootstrapModule,
    // `StimulusIntake` (the `Message`-typed intake seam) is injected by the controller's `/message`
    // composed-turn path. StimulusModule is not `@Global`; it only imports `JobBootstrapModule` + TypeOrm
    // (no back-edge into the surface), so this is a one-directional, cycle-free import.
    StimulusModule,
  ],
  providers: [
    WebSurface,
    // `JobTitleService` injects `JOB_TITLE_CHAIN`, now provided by the `@Global` `TitlingModule`.
    JobTitleService,
    ComposerDraftService,
  ],
  controllers: [WebSurfaceController],
  exports: [WebSurface],
})
export class WebSurfaceModule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private approvalSub?: Subscription;

  constructor(
    private readonly surface: WebSurface,
    private readonly approvals: DecisionApprovalService,
    private readonly asm: AgentSessionManager,
    // The typed surface→driver approval seam (from @Global DriverApprovalGatewayModule) — resolves the
    // ship/merge/amend approval clicks without a ModuleRef service-locator or a surface→driver module cycle.
    private readonly driverApproval: DriverApprovalGateway,
    // `moduleRef` is still needed by the atlas-prod DB-write path (`resolveDbWrite`), which resolves
    // `ProdDiagnosticsService` lazily — that lookup is out of scope for the driver-approval gateway.
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    this.approvalSub = this.surface.approval$.subscribe(
      ({ actionId, value, ruledBy, note }) => {
        const meta = parseWebApprovalMeta(value);
        if (!meta) return;

        // SHIP-REVIEW gate: not a plan verdict — resume the driver so it re-reaches `finalizeBuild` and ships.
        // Forwarded through the neutral DriverApprovalGateway (the surface must not import the driver — that
        // would form a cycle, DriverModule already depends on the surface for CHAT_SURFACE). Idempotent:
        // `resolveShipApprovalDurably` only acts while the job is `awaiting_ship_review`, so a stale/double
        // click is a no-op.
        if (actionId === SHIP_ACTION_ID) {
          void this.driverApproval
            .resolveShip(meta.jobId, ruledBy)
            .catch(() => undefined);
          return;
        }

        // RETRACT the ship-review gate: the "Back to building" click. `retractShipDurably` is idempotent
        // (acts only while parked), so a stale click is a safe no-op.
        if (actionId === RETRACT_SHIP_ACTION_ID) {
          void this.driverApproval
            .retractShip(meta.jobId, ruledBy)
            .catch(() => undefined);
          return;
        }

        // APPROVE the brain's "Amend build?" proposal: run the SAME operator retract path (so the retract note
        // is operator-authored, never "Operator wants…"), neutralize the proposal card, and — only if the
        // retract actually fired — wake the brain to do the follow-up work. Idempotent throughout.
        if (actionId === AMEND_APPROVE_ACTION_ID) {
          void amendApprove(
            this.driverApproval,
            this.asm,
            meta.jobId,
            ruledBy,
          ).catch(() => undefined);
          return;
        }

        // DISMISS the brain's amend proposal: just neutralize the card. The gate stays parked at ship-review.
        if (actionId === AMEND_DISMISS_ACTION_ID) {
          void this.driverApproval
            .neutralizeAmendProposal(
              meta.jobId,
              'Dismissed — staying at ship review.',
            )
            .catch(() => undefined);
          return;
        }

        // atlas-prod gated DB write: EXECUTE or DENY the operator-approved statement. Not a plan verdict — the
        // `writeId` (the ledger row to act on) rides in the card `value` alongside `jobId`; `parseWebApprovalMeta`
        // only surfaces `jobId`, so parse `writeId` from the raw value here. `executeApproved`/`denyWrite` are
        // idempotent (act only on a `pending` row), so a stale/double click is a safe no-op.
        if (
          actionId === DB_WRITE_APPROVE_ACTION_ID ||
          actionId === DB_WRITE_DENY_ACTION_ID
        ) {
          const writeId = parseWriteId(value);
          if (!writeId) return;
          const approve = actionId === DB_WRITE_APPROVE_ACTION_ID;
          // `meta.jobId` is the card's authorized job — the controller already validated it matches the route
          // job and belongs to the caller's org. Pass it down so the ledger row is verified to belong to it
          // (a foreign/stale `writeId` can't be executed/denied on the back of an unrelated job's approval).
          void resolveDbWrite(
            this.moduleRef,
            writeId,
            meta.jobId,
            ruledBy,
            approve,
          ).catch(() => undefined);
          return;
        }

        const verdict = actionIdToVerdict(actionId);
        if (!verdict) return;

        const resolved = this.approvals.resolve(
          meta.jobId,
          verdict,
          ruledBy,
          note,
          meta.decisionRecordId,
        );
        if (!resolved) {
          // No LIVE in-memory handle. Either a genuinely stale/double click, OR the in-memory pending map
          // was dropped by a restart while the thread stayed durably `awaiting_approval` (the documented
          // durability gap). Fall back to the restart-safe durable resolver, which acts only if the job is
          // still awaiting — so a true stale click remains a no-op. Fire-and-forget; errors are logged.
          void this.asm
            .resolveApprovalDurably(
              meta.jobId,
              verdict,
              ruledBy,
              note,
              meta.decisionRecordId,
            )
            .catch(() => undefined);
        }
      },
    );
  }

  onApplicationShutdown(): void {
    this.approvalSub?.unsubscribe();
  }
}

/**
 * APPROVE the brain's "Amend build?" proposal. Runs the operator retract path (attributed to `ruledBy`)
 * through the {@link DriverApprovalGateway}, neutralizes the durable proposal card either way, and wakes the
 * brain ONLY if the retract actually fired (a stale click — the operator already shipped/retracted — returns
 * false, so no spurious wake).
 */
async function amendApprove(
  driverApproval: DriverApprovalGateway,
  asm: AgentSessionManager,
  jobId: string,
  ruledBy: string,
): Promise<void> {
  const acted = await driverApproval.retractShip(jobId, ruledBy);
  await driverApproval.neutralizeAmendProposal(
    jobId,
    'Approved — amending the build.',
  );
  if (acted) await asm.wakeForAmendApproved(jobId);
}

/**
 * Extract the `writeId` (the `prod_maintenance_write` ledger row id) from a db-write card's action
 * `value`. The card's value is `{ jobId, writeId }`; `parseWebApprovalMeta` only surfaces `jobId`, so the
 * db-write branch parses the raw value directly. Returns undefined for a malformed/non-db-write payload.
 */
function parseWriteId(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.writeId === 'string' ? parsed.writeId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * EXECUTE or DENY an operator-approved atlas-prod DB write. Lazily resolves {@link ProdDiagnosticsService}
 * from the app-wide DI graph (a dynamic import keeps the surface⇄prod-mcp dependency out of module load,
 * mirroring the ship/amend lazy-driver resolution). Both `executeApproved` and `denyWrite` are idempotent
 * (act only on a `pending` ledger row), so a stale/double click is a safe no-op.
 */
async function resolveDbWrite(
  moduleRef: ModuleRef,
  writeId: string,
  expectedJobId: string,
  ruledBy: string,
  approve: boolean,
): Promise<void> {
  const { ProdDiagnosticsService } =
    await import('../prod-mcp/prod-diagnostics.service.js');
  const svc = moduleRef.get(ProdDiagnosticsService, { strict: false });
  if (approve) await svc.executeApproved(writeId, ruledBy, expectedJobId);
  else await svc.denyWrite(writeId, ruledBy, expectedJobId);
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
