import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/** The exact lifecycle a proposed recovery write moves through. Stored as a text column (repo convention
 * — no Postgres enums), never as a DB enum. */
export type ProdMaintenanceWriteStatus =
  | 'pending'
  | 'approved'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'superseded';

/** Pre-approval preview captured at propose time (d6): a PLANNER ESTIMATE from `EXPLAIN <statement>` on the
 * SELECT-only `mcp_reader` role — no DML runs, the write credential is untouched. `error` records an
 * EXPLAIN-time failure (syntax/bad column) so the operator sees the statement will fail before approving. */
export type ProdMaintenanceWriteDryRun = {
  estimatedRows?: number;
  plan?: string;
  error?: string;
};

/** Actual execution outcome, captured post-approval when `mcp_writer` runs the exact approved statement. */
export type ProdMaintenanceWriteResult = {
  affectedRows?: number;
  error?: string;
};

/**
 * The maintenance-write audit/pending ledger — BOTH the pending-approval state AND the durable audit
 * record for the human-gated prod-recovery write path (`atlas-prod` MCP). `status` tracks the lifecycle so
 * there is no in-RAM pending state a backend restart could drop, and every proposed write (approved or not,
 * executed or not) leaves a permanent row. Append-then-update; rows are never deleted (audit).
 *
 * Written ONLY by the backend's normal `app` connection — never by the DML-only `mcp_writer` role, which is
 * explicitly REVOKEd all write on this table (`infra/mcp-writer-role.sql`) so an approved arbitrary
 * statement can never tamper with its own audit trail.
 */
@Entity({ name: 'prod_maintenance_write' })
@Index(['job_id', 'status'])
export class ProdMaintenanceWriteEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The proposing job's org (from the tool closure, never a tool arg — tenant safety). */
  @Column({ type: 'uuid' })
  org_id!: string;

  /** The proposing job's repo (must be the Atlas repo per d3). */
  @Column({ type: 'text' })
  repo_id!: string;

  /** The proposing job (jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  /** The brain engine session id that proposed the write (for the audit trail). */
  @Column({ type: 'text', nullable: true })
  proposed_by_session!: string | null;

  /** The EXACT single statement proposed — the approved artifact, immutable after propose. */
  @Column({ type: 'text' })
  sql!: string;

  @Column({ type: 'text', default: 'pending' })
  status!: ProdMaintenanceWriteStatus;

  /** Preview captured at propose time (see `ProdMaintenanceWriteDryRun`). */
  @Column({ type: 'jsonb' })
  dry_run!: ProdMaintenanceWriteDryRun;

  /** users.id of the approver; null until approved. */
  @Column({ type: 'uuid', nullable: true })
  approved_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approved_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  executed_at!: Date | null;

  /** Actual execution outcome; null until executed/failed (see `ProdMaintenanceWriteResult`). */
  @Column({ type: 'jsonb', nullable: true })
  result!: ProdMaintenanceWriteResult | null;
}
