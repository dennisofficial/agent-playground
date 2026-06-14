import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A long-lived background engine conversation (an employee's "Claude Code" worker), made DURABLE.
 * The in-memory registry (InMemorySessionRegistry) was the v0 and lost every session on restart;
 * this table is the swap that lets sessions survive — the row carries `engine_session_id`, the
 * engine's own resume handle, so a reply after a restart resumes the on-disk SDK transcript by id.
 *
 * What is NOT stored here: the live transcript event buffer (kept in-memory for check_session
 * narration — the SDK's own JSONL under the engine home is the real record) and the in-flight
 * AbortController. A `running` row whose process died is reconciled to `failed` on boot.
 */
@Entity({ name: 'sessions' })
@Index(['owner_bot'])
@Index(['status'])
@Index(['worktree_id'])
export class Session extends TimestampedEntity {
  /** App-generated id (`sess-<8hex>`) — the handle tools and relays address. */
  @PrimaryColumn({ type: 'text' })
  id!: string;

  /** The opening task — titles list_sessions and the worklog entry written on close. */
  @Column({ type: 'text' })
  task!: string;

  /** The worktree this session runs in (durable; re-adopted from git on boot). */
  @Column({ type: 'text' })
  worktree_id!: string;

  // 'running' | 'idle' | 'closed' | 'failed'
  @Column({ type: 'text' })
  status!: string;

  /** The chat surface/thread the session was opened from (memory-identity scoping on relay). */
  @Column({ type: 'text' })
  notify_thread!: string;

  /** Roster bot id that owns this session — scopes session tools and routes turn-end relays. */
  @Column({ type: 'text' })
  owner_bot!: string;

  /** The tenant (Slack team id) — resolves the engine's LLM key and scopes the worklog. */
  @Column({ type: 'text' })
  team!: string;

  /** The project/workspace this work belongs to. */
  @Column({ type: 'text' })
  project!: string;

  /** Which worker engine runs this session (claude / codex / langgraph). */
  @Column({ type: 'text' })
  engine!: string;

  /** The mode of the LATEST turn ('plan' | 'execute') — per-turn switchable. */
  @Column({ type: 'text' })
  mode!: string;

  /** The engine's own session/thread id — the resume handle, recorded once the worker reports it. */
  @Column({ type: 'text', nullable: true })
  engine_session_id!: string | null;

  /** How many turns have completed. */
  @Column({ type: 'int', default: 0 })
  turns!: number;

  /** The latest turn's report — what relayed back to the owner. */
  @Column({ type: 'text', nullable: true })
  last_report!: string | null;

  // 'plan' | 'questions' | null — what kind of report the last turn produced.
  @Column({ type: 'text', nullable: true })
  last_report_kind!: string | null;

  /** Planning Q&A ledger: each asking-turn's report paired with the owner's answer, in order. */
  @Column({ type: 'jsonb', nullable: true })
  qa!: { q: string; a: string }[] | null;

  /** The team-board task this session works, when linked (the approval guard's anchor). */
  @Column({ type: 'int', nullable: true })
  board_task_id!: number | null;

  /** Whether the last turn's finished plan was durably attached to the linked board task. */
  @Column({ type: 'boolean', nullable: true })
  plan_attached!: boolean | null;

  /** The last turn's error message when `status` is 'failed'. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;
}
