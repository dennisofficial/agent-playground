import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { TurnEnvelope } from '../../_shared/domain';
import { atlasAgentHomeBase } from '../../_shared/engine/engine-home';
import { agentMessage, type AgentMessage } from '../../_shared/prompt-kit/message';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import {
  DB_CONNECTION,
  MCP_READER_CONNECTION,
  MCP_WRITER_CONNECTION,
} from '../persistence/database.module';
import {
  ProdMaintenanceWriteEntity,
  TranscriptMessageEntity,
  type ProdMaintenanceWriteDryRun,
  type ProdMaintenanceWriteResult,
} from '../persistence/entities';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { webDbWriteApprovalCard, webVerdictCard } from '../surface/web-approval-card';
import { audit } from './audit';
import { redactSecrets } from './redact';
import { TOOL_HANDLERS, type ToolCtx, type ToolRoots } from './tools';
import { assertSingleWriteStatement } from './write-guard';

const PG_PERMISSION_DENIED = '42501';

function pgErrorCode(err: unknown): string | undefined {
  const withCode = err as { code?: unknown; driverError?: { code?: unknown } };
  const code = withCode?.code ?? withCode?.driverError?.code;
  return typeof code === 'string' ? code : undefined;
}

@Injectable()
export class ProdDiagnosticsService {
  constructor(
    @Optional()
    @InjectDataSource(MCP_READER_CONNECTION)
    private readonly reader: DataSource | undefined,
    @Optional()
    @InjectDataSource(MCP_WRITER_CONNECTION)
    private readonly writer: DataSource | undefined,
    @InjectRepository(ProdMaintenanceWriteEntity, DB_CONNECTION)
    private readonly ledger: Repository<ProdMaintenanceWriteEntity>,
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    @Inject(CHAT_SURFACE)
    private readonly surface: ChatSurface,
    private readonly env: EnvService,
    private readonly jobBootstrap: JobBootstrapService,
  ) {}

  private roots(): ToolRoots {
    return {
      agentHome: atlasAgentHomeBase(this.env.get('AGENT_HOME_ROOT')),
      repos: this.env.get('REPOS_ROOT') ?? '',
    };
  }

  private requireReader(): DataSource {
    if (!this.reader) throw new Error('prod reader DataSource not configured');
    return this.reader;
  }

  async runRead(name: string, args: unknown): Promise<unknown> {
    const ds = this.requireReader();
    const handler = TOOL_HANDLERS[name];
    if (!handler) throw new Error(`unknown read tool: ${name}`);
    const ctx: ToolCtx = { ds, roots: this.roots(), audit: {} };
    const jobId =
      typeof (args as Record<string, unknown> | undefined)?.jobId === 'string'
        ? ((args as Record<string, unknown>).jobId as string)
        : undefined;
    try {
      const result = await handler(ctx, args as Record<string, unknown>);
      audit({
        tool: name,
        jobId,
        orgId: ctx.audit.orgId,
        ok: true,
        sql: ctx.audit.sql ? (redactSecrets(ctx.audit.sql) as string) : undefined,
        rows: ctx.audit.rowCount,
      });
      return redactSecrets(result);
    } catch (err) {
      audit({
        tool: name,
        jobId,
        orgId: ctx.audit.orgId,
        ok: false,
        error: redactSecrets(String((err as Error)?.message ?? err)) as string,
        sql: ctx.audit.sql ? (redactSecrets(ctx.audit.sql) as string) : undefined,
        rows: ctx.audit.rowCount,
      });
      throw err;
    }
  }

  private async previewWrite(stmt: string): Promise<ProdMaintenanceWriteDryRun> {
    const reader = this.requireReader();
    try {
      const rows: Array<Record<string, unknown>> = await reader.query(
        `EXPLAIN (FORMAT JSON) ${stmt}`,
      );
      const planPayload = rows?.[0]?.['QUERY PLAN'];
      const planRoot = Array.isArray(planPayload) ? planPayload[0] : undefined;
      const topPlan = (planRoot as { Plan?: Record<string, unknown> } | undefined)?.Plan;
      const estimatedRows =
        typeof topPlan?.['Plan Rows'] === 'number' ? (topPlan['Plan Rows'] as number) : undefined;
      return {
        plan: planRoot ? JSON.stringify(planRoot) : undefined,
        ...(estimatedRows !== undefined ? { estimatedRows } : {}),
      };
    } catch (err) {
      if (pgErrorCode(err) === PG_PERMISSION_DENIED) return {};
      return {
        error: redactSecrets(String((err as Error)?.message ?? err)) as string,
      };
    }
  }

  async proposeWrite(
    stimulus: TurnEnvelope,
    sql: string,
  ): Promise<{ ok: true; writeId: string; message: string }> {
    const stmt = assertSingleWriteStatement(sql);
    const dryRun = await this.previewWrite(stmt);

    const saved = await this.ledger.save(
      this.ledger.create({
        org_id: stimulus.orgId,
        repo_id: stimulus.repoId,
        job_id: stimulus.jobId,
        proposed_by_session: stimulus.id ?? null,
        sql: stmt,
        status: 'pending',
        dry_run: dryRun,
      }),
    );
    const writeId = saved.id;
    const estimateLabel: 'estimate' | 'unavailable' | 'error' = dryRun.error
      ? 'error'
      : dryRun.plan
        ? 'estimate'
        : 'unavailable';

    const threadId = await this.jobBootstrap.planningThreadId(stimulus.jobId);
    await this.messages.save(
      this.messages.create({
        job_id: stimulus.jobId,
        thread_id: threadId,
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: 'Approve prod DB write',
        kind: 'card',
        ts: `db-write:${stimulus.jobId}:${writeId}`,
        card: webDbWriteApprovalCard({
          jobId: stimulus.jobId,
          writeId,
          sql: stmt,
          estimatedRows: dryRun.estimatedRows,
          estimateLabel,
          ...(dryRun.error ? { error: dryRun.error } : {}),
        }) as unknown as Record<string, unknown>,
      }),
    );
    await this.surface.post(
      stimulus.repoId,
      ':warning: A prod DB write is awaiting your approval.',
      { threadTs: stimulus.jobId, orgId: stimulus.orgId },
    );

    return { ok: true, writeId, message: 'Proposed — pending your approval' };
  }

  async executeApproved(
    writeId: string,
    approverUserId: string,
    expectedJobId: string,
  ): Promise<void> {
    const row = await this.ledger.findOne({ where: { id: writeId } });
    if (!row || row.status !== 'pending') return;
    if (row.job_id !== expectedJobId) return;

    const claim = await this.ledger.update(
      { id: writeId, status: 'pending' },
      {
        status: 'approved',
        approved_by: approverUserId,
        approved_at: new Date(),
      },
    );
    if (!claim.affected) return;

    if (!this.writer) {
      await this.ledger.update(writeId, {
        status: 'failed',
        result: { error: 'prod writer DataSource not configured' },
        executed_at: new Date(),
      });
      await this.settleApprovalCard(
        row,
        'Prod DB write failed',
        'deny',
        'Failed: prod writer DataSource not configured.',
      );
      await this.notify(
        row,
        agentMessage('<prod DB write> FAILED: prod writer DataSource not configured.'),
      );
      return;
    }

    let result: ProdMaintenanceWriteResult;
    let status: 'executed' | 'failed';
    try {
      const affectedRows = await this.runOnWriter(row.sql);
      result = { affectedRows };
      status = 'executed';
    } catch (err) {
      result = {
        error: redactSecrets(String((err as Error)?.message ?? err)) as string,
      };
      status = 'failed';
    }

    await this.ledger.update(writeId, {
      status,
      result,
      executed_at: new Date(),
    });

    const line =
      status === 'executed'
        ? `Executed — ${result.affectedRows} row(s) changed.`
        : `Failed: ${result.error}`;
    await this.settleApprovalCard(
      row,
      status === 'executed' ? 'Prod DB write executed' : 'Prod DB write failed',
      status === 'executed' ? 'approve' : 'deny',
      line,
    );

    const notice = agentMessage(`<prod DB write> ${line}`);
    await this.notify(row, notice);
  }

  private async runOnWriter(sql: string): Promise<number> {
    const writer = this.writer!;
    const qr = writer.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const res = await qr.query(sql, undefined, true);
      const affectedRows = res.affected ?? res.records?.length ?? 0;
      await qr.commitTransaction();
      return affectedRows;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async denyWrite(writeId: string, approverUserId: string, expectedJobId: string): Promise<void> {
    const row = await this.ledger.findOne({ where: { id: writeId } });
    if (!row || row.status !== 'pending') return;
    if (row.job_id !== expectedJobId) return;

    const claim = await this.ledger.update(
      { id: writeId, status: 'pending' },
      {
        status: 'rejected',
        approved_by: approverUserId,
        approved_at: new Date(),
      },
    );
    if (!claim.affected) return;
    await this.settleApprovalCard(row, 'Prod DB write declined', 'deny', 'Declined by operator.');
    await this.notify(row, agentMessage('<prod DB write> declined.'));
  }

  private async settleApprovalCard(
    row: ProdMaintenanceWriteEntity,
    title: string,
    verdict: 'approve' | 'deny',
    verdictLine: string,
  ): Promise<void> {
    const ts = `db-write:${row.job_id}:${row.id}`;
    const card = webVerdictCard(row.job_id, title, verdict, verdictLine);
    const message = await this.messages.findOne({
      where: { job_id: row.job_id, ts, kind: 'card' },
    });
    if (message) {
      message.text = verdictLine;
      message.card = card as unknown as Record<string, unknown>;
      await this.messages.save(message);
    }
    await this.surface.post(row.repo_id, verdictLine, {
      threadTs: row.job_id,
      orgId: row.org_id,
    });
  }

  private async notify(row: ProdMaintenanceWriteEntity, body: AgentMessage): Promise<void> {
    this.surface.seedSystemNotification?.(row.repo_id, row.job_id, body, {
      orgId: row.org_id,
    });
  }
}
