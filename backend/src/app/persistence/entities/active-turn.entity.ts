import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { JobEntity } from './job.entity';

/**
 * The durable registry of IN-FLIGHT engine turns running over the Redis-Streams transport
 * (`ENGINE_TRANSPORT=redis`; see ADR 0001). One row per live turn.
 *
 * It is what makes a turn restart-survivable: the ephemeral in-container engine process keeps running
 * (reparented to init) and keeps writing to `turn:{turn_id}:events`, while the host is disposable. On
 * boot a fresh backend reads the `running` rows here and RE-ATTACHES — resuming the event tail from
 * `events_last_id` and re-joining the `turn:{turn_id}:tools` consumer group — instead of losing the turn.
 *
 * `ctx` carries everything needed to rebuild the turn's harness + (for brain turns) the `buildTools`
 * closure on re-attach — the host that re-attaches is NOT the one that started the turn, so it cannot
 * reuse in-memory state. The watchdog finalizes rows whose `last_heartbeat_at` has gone stale (the engine
 * container itself died — the only truly-unrecoverable case).
 */
@Entity({ name: 'active_turns' })
@Index(['status'])
@Index(['job_id'])
// HARD cross-process backstop: at most ONE `running` brain turn per job. Two brain turns resuming the
// same engine session id concurrently is the "parallel co-author" bug (a fresh turn spawned while one is
// already in flight — reattached, steered, or started by a second app instance). The in-memory turn queue
// can't coordinate across processes; this partial unique index rejects the second `register()` at the DB,
// and the loser degrades to an idempotent steer. Partial: only brain turns in `running` are constrained —
// step/review/autofix turns and terminal (`done`/`failed`) rows are exempt.
@Index('ux_active_turns_one_running_brain_per_job', ['job_id'], {
  unique: true,
  where: `"kind" = 'brain' AND "status" = 'running'`,
})
export class ActiveTurnEntity extends TimestampedEntity {
  /** The turn id — also the Redis stream-key namespace (`turn:{turn_id}:*`). */
  @PrimaryColumn({ type: 'uuid' })
  turn_id!: string;

  /** The thread this turn belongs to (FK → threads.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  /** The tenant (denormalized for sandbox resolution + scoping). */
  @Column({ type: 'uuid' })
  org_id!: string;

  /** The surface channel (repo id) the turn streams to — the SSE fan-out key. */
  @Column({ type: 'text' })
  channel!: string;

  /** Transcript lane: 'main' for the brain, 'thread:<threadId>' for a build thread. */
  @Column({ type: 'text', default: 'main' })
  lane!: string;

  /** Which caller owns the turn — selects how a re-attach rebuilds the harness + tool context. */
  @Column({ type: 'text' })
  kind!: 'brain' | 'step' | 'review' | 'gate' | 'autofix';

  /** The sandbox container running the ephemeral engine process (for liveness/teardown). */
  @Column({ type: 'text', nullable: true })
  container_id!: string | null;

  /** Lifecycle: 'running' (engine in flight) | 'done' | 'failed'. */
  @Column({ type: 'text', default: 'running' })
  status!: 'running' | 'done' | 'failed';

  /** The id of the last `turn:{turn_id}:events` entry consumed — the resume cursor for re-attach. */
  @Column({ type: 'text', default: '0-0' })
  events_last_id!: string;

  /** Last engine heartbeat; null until the first one. A stale value → the watchdog finalizes the turn. */
  @Column({ type: 'timestamptz', nullable: true })
  last_heartbeat_at!: Date | null;

  /**
   * Everything a fresh host needs to rebuild the turn's harness + (brain) `buildTools` closure on
   * re-attach: orgId/repoId/jobId, author, the originating prompt, route, the resumable session id,
   * timeouts, etc. Shape is per-`kind`; opaque jsonb here.
   */
  @Column({ type: 'jsonb', default: JSON.stringify({}) })
  ctx!: Record<string, unknown>;
}
