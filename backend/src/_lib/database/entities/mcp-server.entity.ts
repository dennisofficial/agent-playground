import { TimestampedEntity } from '@lib/database/base.entity';
import { Column, Entity, Index, PrimaryGeneratedColumn, Repository } from 'typeorm';

/**
 * A third-party MCP server made available to an org's jobs — the sandbox provisions it INTO the container
 * for the agent to use (distinct from the agent-facing `workspace-profile` tool server). `repoId` null →
 * org-tier (all repos); set → repo-tier. Minimal stub this pass; logic lands with the sandbox runtime.
 */
@Entity({ name: 'mcp_servers' })
@Index(['orgId'])
export class McpServer extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orgId!: string;

  /** Null → org-tier (applies to every repo); set → scoped to one repo. */
  @Column({ type: 'uuid', nullable: true })
  repoId!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;
}

export class McpServerRepo extends Repository<McpServer> {}
