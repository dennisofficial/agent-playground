import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * Idempotency ledger for host-bridge tool executions over the Redis transport. The tools stream delivers
 * at-least-once (a request is redelivered if its host consumer DIED after executing but before `ack`),
 * and most host tools have side effects (DB writes, thread/container spawns, git/PR). This table is the
 * guard: dispatch records `(turn_id, tool_call_id)` with its result; on redelivery the host finds the row
 * and RE-POSTS the cached reply instead of re-running the tool. See ADR 0001.
 *
 * Composite PK `(turn_id, tool_call_id)` — `tool_call_id` is the engine-generated UUID that correlates a
 * request to its reply, stable across redelivery.
 */
@Entity({ name: 'tool_executions' })
export class ToolExecutionEntity extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  turn_id!: string;

  @PrimaryColumn({ type: 'uuid' })
  tool_call_id!: string;

  @Column({ type: 'text' })
  tool_name!: string;

  /** The reply frame payload (a `tool_response`.result or a `tool_error`.message), re-posted on redelivery. */
  @Column({ type: 'jsonb' })
  reply!: Record<string, unknown>;
}
