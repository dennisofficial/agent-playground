import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A dynamically-attached employee MCP server (the DB-controlled parallel to {@link EmployeeSkill}).
 * An employee's MCP servers come from byte-stable code constants PLUS any rows here. `team_id` NULL =
 * the SHARED/global tier (every workspace's copy of this employee loads it); a non-null `team_id` is
 * a per-workspace override (deferred — the engine homes are global per employee). `config` is the
 * `McpServerConfig` JSON the engines pass.
 *
 * NOTE: `config` may carry secrets in `env`/`headers`. v1 stores it as plain jsonb (parity with
 * {@link EmployeeSkill}); moving secret-bearing fields to the AES-256-GCM path used by `github_tokens`
 * is a tracked follow-up.
 */
@Entity({ name: 'employee_mcp_servers' })
@Index(['employee_id', 'team_id'])
export class EmployeeMcpServer extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The roster employee id ('alex') this MCP server attaches to. */
  @Column({ type: 'text' })
  employee_id!: string;

  /** NULL = shared/global (all workspaces); non-null = a single workspace's override. */
  @Column({ type: 'text', nullable: true })
  team_id!: string | null;

  /** The MCP server name (the key engines register it under). */
  @Column({ type: 'text' })
  name!: string;

  /** The `McpServerConfig` discriminated union as JSON (stdio | http). */
  @Column({ type: 'jsonb' })
  config!: Record<string, unknown>;
}
