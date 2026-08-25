import { Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { AgentSessionManager } from '../brain/agent-session-manager.service';
import type { ApprovalVerdict } from '../brain/decision-approval.service';
import { DecisionApprovalService } from '../brain/decision-approval.service';
import { DriverApprovalGateway } from '../driver-approval-gateway/driver-approval-gateway.service';
import { GitModule } from '../git/git.module';
import { JobBootstrapModule } from '../job-bootstrap/job-bootstrap.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ComposerDraftAttachmentEntity,
  ComposerDraftEntity,
  JobEntity,
  RepoEntity,
  SubagentEntity,
  TranscriptMessageEntity,
} from '../persistence/entities';
import { StimulusModule } from '../stimulus/stimulus.module';
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
import { ComposerDraftService } from './composer-draft.service';
import { JobTitleService } from './job-title.service';
import { parseWebApprovalMeta } from './web-approval-card';
import { WebSurface } from './web-surface';
import { WebSurfaceController } from './web-surface.controller';

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
    GitModule,
    JobBootstrapModule,
    StimulusModule,
  ],
  providers: [WebSurface, JobTitleService, ComposerDraftService],
  controllers: [WebSurfaceController],
  exports: [WebSurface],
})
export class WebSurfaceModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private approvalSub?: Subscription;

  constructor(
    private readonly surface: WebSurface,
    private readonly approvals: DecisionApprovalService,
    private readonly asm: AgentSessionManager,
    private readonly driverApproval: DriverApprovalGateway,
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    this.approvalSub = this.surface.approval$.subscribe(({ actionId, value, ruledBy, note }) => {
      const meta = parseWebApprovalMeta(value);
      if (!meta) return;

      if (actionId === SHIP_ACTION_ID) {
        void this.driverApproval.resolveShip(meta.jobId, ruledBy).catch(() => undefined);
        return;
      }

      if (actionId === RETRACT_SHIP_ACTION_ID) {
        void this.driverApproval.retractShip(meta.jobId, ruledBy).catch(() => undefined);
        return;
      }

      if (actionId === AMEND_APPROVE_ACTION_ID) {
        void amendApprove(this.driverApproval, this.asm, meta.jobId, ruledBy).catch(
          () => undefined,
        );
        return;
      }

      if (actionId === AMEND_DISMISS_ACTION_ID) {
        void this.driverApproval
          .neutralizeAmendProposal(meta.jobId, 'Dismissed — staying at ship review.')
          .catch(() => undefined);
        return;
      }

      if (actionId === DB_WRITE_APPROVE_ACTION_ID || actionId === DB_WRITE_DENY_ACTION_ID) {
        const writeId = parseWriteId(value);
        if (!writeId) return;
        const approve = actionId === DB_WRITE_APPROVE_ACTION_ID;
        void resolveDbWrite(this.moduleRef, writeId, meta.jobId, ruledBy, approve).catch(
          () => undefined,
        );
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

async function amendApprove(
  driverApproval: DriverApprovalGateway,
  asm: AgentSessionManager,
  jobId: string,
  ruledBy: string,
): Promise<void> {
  const acted = await driverApproval.retractShip(jobId, ruledBy);
  await driverApproval.neutralizeAmendProposal(jobId, 'Approved — amending the build.');
  if (acted) await asm.wakeForAmendApproved(jobId);
}

function parseWriteId(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.writeId === 'string' ? parsed.writeId : undefined;
  } catch {
    return undefined;
  }
}

async function resolveDbWrite(
  moduleRef: ModuleRef,
  writeId: string,
  expectedJobId: string,
  ruledBy: string,
  approve: boolean,
): Promise<void> {
  const { ProdDiagnosticsService } = await import('../prod-mcp/prod-diagnostics.service.js');
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
