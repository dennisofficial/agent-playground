import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
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
   * How the server authenticates. `'static'` (default) = the header/env secrets in {@link secrets_enc}; `'oauth'`
   * = interactive OAuth 2.1 (DCR + PKCE), whose client registration + tokens live in {@link oauth_enc} and are
   * managed by `McpOAuthService`, NOT by the console `write`. Only remote (`http`/`sse`) servers can be `'oauth'`.
   */
  @Column({ type: 'text', default: 'static' })
  auth_kind!: McpAuthKind;

  /**
   * AES-256-GCM ciphertext (`secret-cipher.ts`) of the {@link McpOAuthBlob} — the DCR client registration, the
   * access/refresh tokens, and the in-flight PKCE verifier + consent nonce. Null for a `'static'` server or an
   * `'oauth'` server that has not completed consent yet. Never logged, never returned to a client (the console
   * only ever sees the boolean "connected" derived from `oauth_enc != null`). Owned by `McpOAuthService`.
   */
  @Column({ type: 'text', nullable: true })
  oauth_enc!: string | null;

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

/** How a server authenticates: static header/env secrets, or interactive OAuth 2.1 (DCR + PKCE). */
export type McpAuthKind = 'static' | 'oauth';

/** The OAuth token-endpoint client-auth method for DCR — `'none'` = public client + PKCE (the default). */
export type McpOAuthTokenAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

/**
 * Non-secret OAuth knobs stored in {@link StoredMcpConfig.oauth} (displayable; the tokens themselves live
 * encrypted in `oauth_enc`). `scope` is the OAuth scope string to request (provider-specific; omit to let the
 * server's metadata decide). `tokenAuthMethod` defaults to `'none'` (public client + PKCE — what Atlassian uses).
 */
export interface StoredMcpOAuthConfig {
  scope?: string;
  tokenAuthMethod?: McpOAuthTokenAuthMethod;
}

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
  /** Non-secret OAuth knobs (only meaningful when `auth_kind='oauth'`). */
  oauth?: StoredMcpOAuthConfig;
}

/** The decrypted secret values, split by where they belong (a header value vs an env value). */
export interface McpSecretValues {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/**
 * The decrypted contents of `oauth_enc` for an `auth_kind='oauth'` server — the DCR client registration, tokens,
 * and in-flight PKCE/consent state managed by `McpOAuthService`. The SDK OAuth types are kept as structural shapes here
 * so this entity file stays free of a static `@modelcontextprotocol/sdk` import (an ESM-only dep the host loads
 * via dynamic `import()`); `McpOAuthService` casts to/from the SDK types at the boundary.
 */
export interface McpOAuthBlob {
  /** The Dynamic Client Registration result (client_id, redirect_uris, …). */
  clientInformation?: Record<string, unknown>;
  /** The OAuth tokens (access_token, refresh_token, expires_in, …). */
  tokens?: Record<string, unknown>;
  /** Epoch ms the tokens were obtained/refreshed — with `tokens.expires_in`, drives proactive refresh. */
  obtainedAt?: number;
  /** In-flight PKCE code verifier (present only between `beginAuthorization` and the callback). */
  codeVerifier?: string;
  /** The exact redirect_uri declared at DCR — reused verbatim at token exchange. */
  redirectUri?: string;
  /** The discovered authorization-server URL, cached so refresh needs no re-discovery. */
  authServerUrl?: string;
  /** In-flight consent nonce embedded in the signed `state` — gates callback replay. */
  nonce?: string;
  /** The SDK's cached OAuth discovery state (opaque) — lets refresh skip re-discovery. */
  discoveryState?: Record<string, unknown>;
}
