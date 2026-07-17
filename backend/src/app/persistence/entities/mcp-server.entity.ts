import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';

@Entity({ name: 'mcp_servers' })
@Index(['org_id'])
export class McpServerEntity extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @PrimaryColumn({ type: 'text', default: '*' })
  scope!: string;

  @PrimaryColumn({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  transport!: 'http' | 'sse' | 'stdio';

  @Column({ type: 'text', default: 'static' })
  auth_kind!: McpAuthKind;

  @Column({ type: 'text', nullable: true })
  oauth_enc!: string | null;

  @Column({ type: 'jsonb', default: {} })
  config!: StoredMcpConfig;

  @Column({ type: 'text', nullable: true })
  secrets_enc!: string | null;

  @Column({ type: 'jsonb', default: ['brain', 'build'] })
  surfaces!: McpSurface[];

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  discovered_tools!: string[] | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_validated_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  validation_error!: string | null;
}

export type McpSurface = 'brain' | 'build' | 'review';

export type McpAuthKind = 'static' | 'oauth';

export type McpOAuthTokenAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface StoredMcpOAuthConfig {
  scope?: string;
  tokenAuthMethod?: McpOAuthTokenAuthMethod;
}

export interface StoredMcpConfig {
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string | null>;
  env?: Record<string, string | null>;
  oauth?: StoredMcpOAuthConfig;
}

export interface McpSecretValues {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpOAuthBlob {
  clientInformation?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  obtainedAt?: number;
  codeVerifier?: string;
  redirectUri?: string;
  authServerUrl?: string;
  nonce?: string;
  discoveryState?: Record<string, unknown>;
}
