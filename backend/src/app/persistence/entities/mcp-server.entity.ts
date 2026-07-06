import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';

/**
 * A user-defined MCP (Model Context Protocol) server the operator registered in the console, so the
 * in-sandbox brain/build/review sessions can call its tools as `mcp__<name>__<tool>`. Resolved host-side
 * per turn by `McpResolver` and threaded onto the turn spec (`RunEngineArgs.userMcpServers`).
 *
 * Composite PK (org_id, scope, name) reuses the {@link OrgCredentialsEntity} scope-sentinel:
 *   - `scope='*'` → an ORG-level server, active for every repo/job in the org.
 *   - `scope=<repoId>` → a REPO-level server, active only for that repo (and OVERRIDES an org server of
 *     the same `name` on a collision — see `McpResolver.resolveForTurn`).
 *
 * `config` holds only NON-SECRET, displayable fields (a secret header/env value is stored as a `null`
 * placeholder). The sensitive values live in `secrets_enc` — AES-256-GCM ciphertext (`secret-cipher.ts`),
 * NEVER in `config`, a column, or a log — exactly like {@link OrgCredentialsEntity}.
 */
@Entity({ name: 'mcp_servers' })
@Index(['org_id'])
export class McpServerEntity extends TimestampedEntity {
  /** The owning org (FK → organizations). */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** '*' = org-wide (all repos); otherwise a repo id — the server is scoped to that repo only. */
  @PrimaryColumn({ type: 'text', default: '*' })
  scope!: string;

  /** Server name — the model addresses its tools as `mcp__<name>__<tool>`. Unique within (org, scope). */
  @PrimaryColumn({ type: 'text' })
  name!: string;

  /** Transport: remote `http`/`sse` (url + headers) or `stdio` (command + args + env). */
  @Column({ type: 'text' })
  transport!: 'http' | 'sse' | 'stdio';

  /**
   * NON-SECRET, fully displayable config. A secret header/env value is a `null` placeholder here; its real
   * value lives (encrypted) in {@link secrets_enc}. Plain-literal default `{}` (NOT a `()=>'{}'::jsonb`
   * expression) so TypeORM's jsonb-aware default compare doesn't regenerate the migration forever.
   */
  @Column({ type: 'jsonb', default: {} })
  config!: StoredMcpConfig;

  /**
   * AES-256-GCM ciphertext of the secret header/env values as `{ headers?: {}, env?: {} }`
   * (`secret-cipher.ts`). Null when the server has no secrets. Never logged, never returned to a client.
   */
  @Column({ type: 'text', nullable: true })
  secrets_enc!: string | null;

  /**
   * Which turn surfaces this server is active on. Plain-literal default (see `config`). Filtered
   * host-side in `McpResolver.resolveForTurn` against the current turn's surface.
   */
  @Column({ type: 'jsonb', default: ['brain', 'build'] })
  surfaces!: McpSurface[];

  /** Master on/off switch — a disabled server is never resolved onto a turn. */
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** Tool names captured at the last validation probe (display only; null until first validated). */
  @Column({ type: 'jsonb', nullable: true })
  discovered_tools!: string[] | null;

  /** When the server was last validated (reachability/handshake probe); null until validated. */
  @Column({ type: 'timestamptz', nullable: true })
  last_validated_at!: Date | null;

  /** The last validation error message, or null when the last probe succeeded / never ran. */
  @Column({ type: 'text', nullable: true })
  validation_error!: string | null;
}

/** The turn surfaces an MCP server can be scoped to. */
export type McpSurface = 'brain' | 'build' | 'review';

/**
 * The non-secret, displayable half of an MCP server config. A `null` value on a header/env key marks a
 * SECRET whose real value lives (encrypted) in `secrets_enc`.
 */
export interface StoredMcpConfig {
  /** Remote (http/sse) endpoint URL. */
  url?: string;
  /** stdio launch command (e.g. `npx`). */
  command?: string;
  /** stdio command args. */
  args?: string[];
  /** Remote headers — value `null` ⇒ the value is a secret in `secrets_enc`. */
  headers?: Record<string, string | null>;
  /** stdio env — value `null` ⇒ the value is a secret in `secrets_enc`. */
  env?: Record<string, string | null>;
}

/** The decrypted secret values, split by where they belong (a header value vs an env value). */
export interface McpSecretValues {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}
