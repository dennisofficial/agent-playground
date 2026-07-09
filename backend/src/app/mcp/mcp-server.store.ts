import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  McpServerEntity,
  type McpAuthKind,
  type McpOAuthBlob,
  type McpSecretValues,
  type McpSurface,
  type StoredMcpConfig,
  type StoredMcpOAuthConfig,
} from '../persistence/entities';
import { decryptSecret, encryptSecret, loadSecretsKey } from '../onboarding/secret-cipher';

/** The org-wide scope sentinel (mirrors `OrgCredentialsEntity.scope`); a non-`*` scope is a repo id. */
export const ORG_SCOPE = '*';

/** One header/env entry from the console form. `secret:true` ⇒ its value is encrypted, never returned. */
export interface McpHeaderInput {
  name: string;
  /** The value; on edit, an EMPTY value for a `secret` entry PRESERVES the stored one (re-enter to change). */
  value: string;
  secret?: boolean;
}

/** The full server definition a `PUT` writes (replaces the row). */
export interface McpServerInput {
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: McpHeaderInput[];
  env?: McpHeaderInput[];
  surfaces?: McpSurface[];
  enabled?: boolean;
  /** `'static'` (default) or `'oauth'`. Writing does NOT touch `oauth_enc` — tokens are owned by `McpOAuthService`. */
  authKind?: McpAuthKind;
  /** Non-secret OAuth knobs (only meaningful when `authKind='oauth'`). */
  oauth?: StoredMcpOAuthConfig;
}

/** A server as returned to a client — NEVER any secret value (secret slots show as `null` in `config`). */
export interface RedactedMcpServer {
  /** 'org' for an org-wide server, otherwise the repo id. */
  scope: 'org' | string;
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  config: StoredMcpConfig;
  /** `header:<name>` / `env:<name>` keys whose value is a stored secret. */
  secretKeys: string[];
  surfaces: McpSurface[];
  enabled: boolean;
  discoveredTools: string[] | null;
  lastValidatedAt: string | null;
  validationError: string | null;
  /** `'static'` or `'oauth'`. */
  authKind: McpAuthKind;
  /** Only for `authKind='oauth'`: whether consent has completed (a token bundle exists). NEVER the token itself. */
  oauthConnected: boolean;
  /** Only for `authKind='oauth'`: whether the last resolve/refresh failed and re-consent is needed. */
  needsReauth: boolean;
}

/**
 * The encrypt-on-write / decrypt-on-read path for user-defined MCP servers. Mirrors
 * {@link WorkspaceSecretFileStore} / {@link TenantCredentialStore}: AES-256-GCM via `secret-cipher`, the
 * `SECRETS_ENCRYPTION_KEY` required to write/read a secret value, values NEVER logged or returned.
 *
 * `scope` is `'*'` for an org-wide server or a repo id for a repo-scoped one. The public API takes the
 * URL-friendly `'org'` alias and maps it to the `'*'` sentinel here (one translation point).
 */
@Injectable()
export class McpServerStore {
  private readonly logger = new Logger(McpServerStore.name);

  constructor(
    @InjectRepository(McpServerEntity, DB_CONNECTION)
    private readonly servers: Repository<McpServerEntity>,
    private readonly env: EnvService,
  ) {}

  private key(): Buffer {
    return loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY'));
  }

  /** URL-facing `'org'` ⇄ DB `'*'`; any other value is a repo id passed through unchanged. */
  static toDbScope(scope: string): string {
    return scope === 'org' ? ORG_SCOPE : scope;
  }
  static fromDbScope(scope: string): 'org' | string {
    return scope === ORG_SCOPE ? 'org' : scope;
  }

  // ── reads (redacted) ────────────────────────────────────────────────────────────────────────

  /** Every server for an org (org-wide + all repo scopes), redacted — never a secret value. */
  async list(orgId: string): Promise<RedactedMcpServer[]> {
    const rows = await this.servers.find({ where: { org_id: orgId } });
    return rows.map((r) => this.redact(r));
  }

  private redact(r: McpServerEntity): RedactedMcpServer {
    const secretKeys: string[] = [];
    for (const [k, v] of Object.entries(r.config.headers ?? {})) if (v === null) secretKeys.push(`header:${k}`);
    for (const [k, v] of Object.entries(r.config.env ?? {})) if (v === null) secretKeys.push(`env:${k}`);
    return {
      scope: McpServerStore.fromDbScope(r.scope),
      name: r.name,
      transport: r.transport,
      config: r.config,
      secretKeys,
      surfaces: r.surfaces,
      enabled: r.enabled,
      discoveredTools: r.discovered_tools,
      lastValidatedAt: r.last_validated_at ? new Date(r.last_validated_at).toISOString() : null,
      validationError: r.validation_error,
      authKind: r.auth_kind,
      // Cheap: a NULL check on the ciphertext column — no decrypt, no token ever leaves the store.
      oauthConnected: r.auth_kind === 'oauth' && r.oauth_enc != null,
      needsReauth: r.auth_kind === 'oauth' && r.validation_error != null,
    };
  }

  // ── writes ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Upsert a server definition. Splits secret header/env values out of `config` (null placeholder) into
   * the encrypted `secrets_enc` blob. A `secret` entry with an EMPTY value preserves the stored value
   * (the console shows presence, not the value; re-enter to change). Writing resets the validation state.
   */
  async write(orgId: string, dbScope: string, name: string, input: McpServerInput): Promise<void> {
    const existing = await this.servers.findOne({
      where: { org_id: orgId, scope: dbScope, name },
    });
    const prior = existing ? this.decryptSecrets(existing) : {};

    const config: StoredMcpConfig = {};
    if (input.url) config.url = input.url;
    if (input.command) config.command = input.command;
    if (input.args && input.args.length > 0) config.args = input.args;

    const secrets: McpSecretValues = {};
    const applyPairs = (
      entries: McpHeaderInput[] | undefined,
      slot: 'headers' | 'env',
    ): void => {
      if (!entries || entries.length === 0) return;
      const bag: Record<string, string | null> = {};
      for (const e of entries) {
        if (!e.name) continue;
        if (e.secret) {
          bag[e.name] = null;
          // Non-empty ⇒ new secret value; empty ⇒ keep the prior stored value (re-enter to change).
          const value = e.value !== '' ? e.value : prior[slot]?.[e.name];
          if (value !== undefined && value !== '') {
            (secrets[slot] ??= {})[e.name] = value;
          }
        } else {
          bag[e.name] = e.value;
        }
      }
      if (Object.keys(bag).length > 0) config[slot] = bag;
    };
    applyPairs(input.headers, 'headers');
    applyPairs(input.env, 'env');

    // Non-secret OAuth knobs live in `config`; the tokens/DCR blob in `oauth_enc` is owned by McpOAuthService
    // and deliberately NOT touched here (so editing e.g. the scope of a connected server keeps its tokens).
    if (input.oauth && Object.keys(input.oauth).length > 0) config.oauth = input.oauth;

    const hasSecrets = !!(secrets.headers || secrets.env);
    const row =
      existing ?? this.servers.create({ org_id: orgId, scope: dbScope, name });
    row.transport = input.transport;
    row.auth_kind = input.authKind ?? 'static';
    row.config = config;
    row.secrets_enc = hasSecrets ? encryptSecret(JSON.stringify(secrets), this.key()) : null;
    row.surfaces = input.surfaces && input.surfaces.length > 0 ? input.surfaces : ['brain', 'build'];
    row.enabled = input.enabled ?? true;
    // A changed config invalidates any prior validation probe.
    row.discovered_tools = null;
    row.last_validated_at = null;
    row.validation_error = null;
    await this.servers.save(row);
    this.logger.log(`wrote mcp server org=${orgId} scope=${dbScope} name=${name}`);
  }

  /**
   * Set ONE secret slot value on an EXISTING server (read-modify-write) without touching the rest of the
   * row — the owner-gated `provide-secret` MCP lane uses this so a provided key lands in `secrets_enc`
   * beside a server the brain registered with empty placeholders. Adds the matching `config[slot][key]`
   * = `null` placeholder if absent (so `redact()` surfaces it as a `secretKeys` entry). Returns `false`
   * (no throw) if the server row is gone. Does NOT reset the validation state — the caller re-probes.
   */
  async setSecret(
    orgId: string,
    dbScope: string,
    name: string,
    slot: 'headers' | 'env',
    key: string,
    value: string,
  ): Promise<boolean> {
    const row = await this.servers.findOne({ where: { org_id: orgId, scope: dbScope, name } });
    if (!row) return false;
    const secrets = this.decryptSecrets(row);
    (secrets[slot] ??= {})[key] = value;
    row.secrets_enc = encryptSecret(JSON.stringify(secrets), this.key());
    const config: StoredMcpConfig = row.config ?? {};
    (config[slot] ??= {})[key] = null;
    row.config = config;
    await this.servers.save(row);
    this.logger.log(`set mcp secret org=${orgId} scope=${dbScope} name=${name} slot=${slot} key=${key}`);
    return true;
  }

  async delete(orgId: string, dbScope: string, name: string): Promise<void> {
    await this.servers.delete({ org_id: orgId, scope: dbScope, name });
    this.logger.log(`deleted mcp server org=${orgId} scope=${dbScope} name=${name}`);
  }

  /** Persist the outcome of a validation probe (tool list or error). */
  async recordValidation(
    orgId: string,
    dbScope: string,
    name: string,
    result: { discoveredTools?: string[]; error?: string },
  ): Promise<void> {
    const row = await this.servers.findOne({ where: { org_id: orgId, scope: dbScope, name } });
    if (!row) return;
    row.discovered_tools = result.error ? null : (result.discoveredTools ?? []);
    row.validation_error = result.error ?? null;
    row.last_validated_at = new Date();
    await this.servers.save(row);
  }

  // ── resolution helpers (used by McpResolver) ─────────────────────────────────────────────────

  /** Raw rows for the org's `'*'` scope plus one repo scope — the input to `McpResolver`. */
  async rowsForTurn(orgId: string, repoId: string): Promise<McpServerEntity[]> {
    return this.servers.find({
      where: [
        { org_id: orgId, scope: ORG_SCOPE },
        { org_id: orgId, scope: repoId },
      ],
    });
  }

  /** Fetch one raw row (for a validation probe that needs the decrypted secrets). */
  async rawRow(orgId: string, dbScope: string, name: string): Promise<McpServerEntity | null> {
    return this.servers.findOne({ where: { org_id: orgId, scope: dbScope, name } });
  }

  /**
   * For each ENABLED org/repo server, the declared secret slots (`header:<k>` / `env:<k>`) that have
   * NO stored value yet — an approved MCP server that silently cannot authenticate until the operator
   * fills them via `request_secret({ mcp })`. Surfaced as a Workspace Profile gap (see
   * `WorkspaceProfileService.computeGaps`); NEVER returns any secret value, only the slot NAMES.
   */
  async unfilledSecretSlots(
    orgId: string,
    repoId: string,
  ): Promise<{ name: string; scope: 'org' | string; slots: string[] }[]> {
    const rows = await this.rowsForTurn(orgId, repoId);
    const out: { name: string; scope: 'org' | string; slots: string[] }[] = [];
    for (const r of rows) {
      if (!r.enabled) continue;
      const filled = this.decryptSecrets(r);
      const slots: string[] = [];
      // A secret slot shows as a `null` placeholder in `config`; it is unfilled when the encrypted blob
      // has no value for that key.
      for (const [k, v] of Object.entries(r.config.headers ?? {}))
        if (v === null && filled.headers?.[k] == null) slots.push(`header:${k}`);
      for (const [k, v] of Object.entries(r.config.env ?? {}))
        if (v === null && filled.env?.[k] == null) slots.push(`env:${k}`);
      if (slots.length > 0) out.push({ name: r.name, scope: McpServerStore.fromDbScope(r.scope), slots });
    }
    return out;
  }

  /** Decrypt a row's secret blob into `{ headers?, env? }`, or `{}` when it has none. */
  decryptSecrets(row: McpServerEntity): McpSecretValues {
    if (!row.secrets_enc) return {};
    return JSON.parse(decryptSecret(row.secrets_enc, this.key())) as McpSecretValues;
  }

  // ── OAuth blob (used ONLY by McpOAuthService) ─────────────────────────────────────────────────

  /** Decrypt a row's `oauth_enc` into an {@link McpOAuthBlob}, or `{}` when it has none. */
  readOAuthBlob(row: McpServerEntity): McpOAuthBlob {
    if (!row.oauth_enc) return {};
    return JSON.parse(decryptSecret(row.oauth_enc, this.key())) as McpOAuthBlob;
  }

  /**
   * Encrypt + persist an {@link McpOAuthBlob} onto an EXISTING oauth server (read-modify-write of the single
   * `oauth_enc` column; no other field touched). Optionally set/clear `validation_error` in the same write —
   * `beginAuthorization`/`completeAuthorization` clear it, a failed refresh sets `'needs re-auth'`. Returns
   * `false` (no throw) if the row is gone.
   */
  async writeOAuthBlob(
    orgId: string,
    dbScope: string,
    name: string,
    blob: McpOAuthBlob,
    opts?: { validationError?: string | null },
  ): Promise<boolean> {
    const row = await this.servers.findOne({ where: { org_id: orgId, scope: dbScope, name } });
    if (!row) return false;
    row.oauth_enc = encryptSecret(JSON.stringify(blob), this.key());
    if (opts && 'validationError' in opts) row.validation_error = opts.validationError ?? null;
    await this.servers.save(row);
    return true;
  }
}
