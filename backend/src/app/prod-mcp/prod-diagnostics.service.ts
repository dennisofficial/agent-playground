import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EnvService } from '@core/config/env/env.service';
import { atlasAgentHomeBase } from '../engine/engine-home';
import type { ChatStimulus } from '../domain/stimulus';
import {
  DB_CONNECTION,
  MCP_READER_CONNECTION,
  MCP_WRITER_CONNECTION,
} from '../persistence/database.module';
import {
  MessageEntity,
  ProdMaintenanceWriteEntity,
  type ProdMaintenanceWriteDryRun,
  type ProdMaintenanceWriteResult,
} from '../persistence/entities';
import { agentMessage, type AgentMessage } from '../prompt-kit/message';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { webDbWriteApprovalCard } from '../surface/web-approval-card';
import { TOOL_HANDLERS, type ToolCtx, type ToolRoots } from '../../mcp-reader/tools';
import { redactSecrets } from '../../mcp-reader/redact';
import { audit } from '../../mcp-reader/audit';
import { assertSingleWriteStatement } from './write-guard';

/** Postgres error code for `permission denied` — what a SELECT-only role gets back from `EXPLAIN` on a
 *  DML statement in this Postgres (confirmed by spike, d6). Expected/benign; NOT surfaced as an error. */
const PG_PERMISSION_DENIED = '42501';

function pgErrorCode(err: unknown): string | undefined {
  const withCode = err as { code?: unknown; driverError?: { code?: unknown } };
  const code = withCode?.code ?? withCode?.driverError?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The `atlas-prod` host-bridge MCP's backend: the 7 relocated read tools (thin wrappers over
 * `mcp-reader/tools.ts`'s `TOOL_HANDLERS`, unchanged) plus the gated `propose_prod_write` /
 * `executeApproved` / `denyWrite` write pipeline. Reads run on the SELECT-only `mcp_reader` pool
 * (also used for the pre-approval EXPLAIN preview); approved writes run on the DML-only `mcp_writer`
 * pool — which this service NEVER touches before an operator approval lands (d2/d4/d6).
 */
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
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @Inject(CHAT_SURFACE)
    private readonly surface: ChatSurface,
    private readonly env: EnvService,
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

  /** Delegate to the relocated `mcp-reader` read-tool handlers, unchanged (redaction + path-jail intact).
   *  Emits one audit line per call (mirroring the standalone `mcp-reader/main.ts`) — the handler stamps
   *  `ctx.audit` (orgId/sql/rowCount) as it runs, so a prod read leaves the same durable audit trail here
   *  as it did through the original standalone reader, on both success and failure. */
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

  /**
   * Preview an already-guard-checked write statement via `EXPLAIN (FORMAT JSON)` on the read-only
   * `mcp_reader` role — a PLANNER ESTIMATE only, no DML runs (d6). A `42501` (permission denied) EXPLAIN
   * failure is the EXPECTED outcome for a DML statement on a SELECT-only role in this Postgres (confirmed
   * by spike) — benign, surfaces as `{}` (estimate unavailable), NOT an error. Any other EXPLAIN failure
   * is a genuine statement problem (syntax/bad column) and surfaces on the card.
   */
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
      return { error: redactSecrets(String((err as Error)?.message ?? err)) as string };
    }
  }

  /**
   * PROPOSE a single write statement: guard, preview (never touching `mcp_writer`), record a `pending`
   * ledger row, and post the operator approval card. Returns immediately (fire-and-forget) — execution
   * happens ONLY via `executeApproved`, triggered solely by the operator's approval click.
   */
  async proposeWrite(
    stimulus: ChatStimulus,
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
    // A genuine EXPLAIN failure (syntax/bad column) MUST be surfaced to the operator before approval —
    // otherwise a benign permission-denied preview and a statement that will actually fail look identical.
    const estimateLabel: 'estimate' | 'unavailable' | 'error' = dryRun.error
      ? 'error'
      : dryRun.plan
        ? 'estimate'
        : 'unavailable';

    // 1. DURABLE — persist the card row so it survives a restart / is visible on refresh.
    await this.messages.save(
      this.messages.create({
        job_id: stimulus.jobId,
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
    // 2. LIVE — nudge SSE so a connected client refetches now.
    await this.surface.post(
      stimulus.repoId,
      ':warning: A prod DB write is awaiting your approval.',
      { threadTs: stimulus.jobId, orgId: stimulus.orgId },
    );

    return { ok: true, writeId, message: 'Proposed — pending your approval' };
  }

  /**
   * EXECUTE an operator-approved write on the DML-only `mcp_writer` role — the ONLY path that runs the
   * statement. The `expectedJobId` is the job the approving operator is authorized for (validated up the
   * stack against the caller's org); the ledger row MUST belong to it, so an enumerated/stale `writeId`
   * from a different job (or org) can't be executed here — the human approval stays tied to the card the
   * operator is actually looking at. Concurrency-safe: the row is claimed atomically (a conditional
   * `pending → approved` update) BEFORE `runOnWriter`, so two near-simultaneous approvals / a double-click
   * can't both execute the statement.
   */
  async executeApproved(
    writeId: string,
    approverUserId: string,
    expectedJobId: string,
  ): Promise<void> {
    const row = await this.ledger.findOne({ where: { id: writeId } });
    if (!row || row.status !== 'pending') return;
    // Ownership: the approval must be for THIS operator's job — never a writeId belonging to another job/org.
    if (row.job_id !== expectedJobId) return;

    // Atomic claim: only the invocation that flips the row out of `pending` proceeds. A concurrent
    // double-approval loses this conditional update (`affected === 0`) and is a no-op — no double-execute.
    const claim = await this.ledger.update(
      { id: writeId, status: 'pending' },
      { status: 'approved', approved_by: approverUserId, approved_at: new Date() },
    );
    if (!claim.affected) return;

    if (!this.writer) {
      await this.ledger.update(writeId, {
        status: 'failed',
        result: { error: 'prod writer DataSource not configured' },
        executed_at: new Date(),
      });
      await this.notify(row, agentMessage('<prod DB write> FAILED: prod writer DataSource not configured.'));
      return;
    }

    let result: ProdMaintenanceWriteResult;
    let status: 'executed' | 'failed';
    try {
      const affectedRows = await this.runOnWriter(row.sql);
      result = { affectedRows };
      status = 'executed';
    } catch (err) {
      result = { error: redactSecrets(String((err as Error)?.message ?? err)) as string };
      status = 'failed';
    }

    await this.ledger.update(writeId, {
      status,
      result,
      executed_at: new Date(),
    });

    const notice =
      status === 'executed'
        ? agentMessage(`<prod DB write> executed — ${result.affectedRows} row(s) changed.`)
        : agentMessage(`<prod DB write> FAILED: ${result.error}`);
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

  /** DENY a pending write — marks it rejected, notifies the job. Idempotent, same as `executeApproved`;
   *  `expectedJobId` gates the row to the approving operator's job so a foreign/stale `writeId` can't be
   *  denied here either. */
  async denyWrite(writeId: string, approverUserId: string, expectedJobId: string): Promise<void> {
    const row = await this.ledger.findOne({ where: { id: writeId } });
    if (!row || row.status !== 'pending') return;
    if (row.job_id !== expectedJobId) return;

    await this.ledger.update(writeId, {
      status: 'rejected',
      approved_by: approverUserId,
      approved_at: new Date(),
    });
    await this.notify(row, agentMessage('<prod DB write> declined.'));
  }

  private async notify(row: ProdMaintenanceWriteEntity, body: AgentMessage): Promise<void> {
    this.surface.seedSystemNotification?.(row.repo_id, row.job_id, body, { orgId: row.org_id });
  }
}
