import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { decryptSecret, encryptSecret, loadSecretsKey } from '../onboarding/secret-cipher';
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

export const ORG_SCOPE = '*';

export interface McpHeaderInput {
  name: string;
  value: string;
  secret?: boolean;
}

export interface McpServerInput {
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: McpHeaderInput[];
  env?: McpHeaderInput[];
  surfaces?: McpSurface[];
  enabled?: boolean;
  authKind?: McpAuthKind;
  oauth?: StoredMcpOAuthConfig;
}

export interface RedactedMcpServer {
  scope: 'org' | string;
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  config: StoredMcpConfig;
  secretKeys: string[];
  surfaces: McpSurface[];
  enabled: boolean;
  discoveredTools: string[] | null;
  lastValidatedAt: string | null;
  validationError: string | null;
  authKind: McpAuthKind;
  oauthConnected: boolean;
  needsReauth: boolean;
}

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

  static toDbScope(scope: string): string {
    return scope === 'org' ? ORG_SCOPE : scope;
  }
  static fromDbScope(scope: string): 'org' | string {
    return scope === ORG_SCOPE ? 'org' : scope;
  }

  async list(orgId: string): Promise<RedactedMcpServer[]> {
    const rows = await this.servers.find({ where: { org_id: orgId } });
    return rows.map((r) => this.redact(r));
  }

  private redact(r: McpServerEntity): RedactedMcpServer {
    const secretKeys: string[] = [];
    for (const [k, v] of Object.entries(r.config.headers ?? {}))
      if (v === null) secretKeys.push(`header:${k}`);
    for (const [k, v] of Object.entries(r.config.env ?? {}))
      if (v === null) secretKeys.push(`env:${k}`);
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
      oauthConnected: this.oauthHasToken(r),
      needsReauth: r.auth_kind === 'oauth' && r.validation_error != null,
    };
  }

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
    const applyPairs = (entries: McpHeaderInput[] | undefined, slot: 'headers' | 'env'): void => {
      if (!entries || entries.length === 0) return;
      const bag: Record<string, string | null> = {};
      for (const e of entries) {
        if (!e.name) continue;
        if (e.secret) {
          bag[e.name] = null;
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

    if (input.oauth && Object.keys(input.oauth).length > 0) config.oauth = input.oauth;

    const hasSecrets = !!(secrets.headers || secrets.env);
    const row = existing ?? this.servers.create({ org_id: orgId, scope: dbScope, name });
    row.transport = input.transport;
    row.auth_kind = input.authKind ?? 'static';
    row.config = config;
    row.secrets_enc = hasSecrets ? encryptSecret(JSON.stringify(secrets), this.key()) : null;
    row.surfaces =
      input.surfaces && input.surfaces.length > 0 ? input.surfaces : ['brain', 'build'];
    row.enabled = input.enabled ?? true;
    row.discovered_tools = null;
    row.last_validated_at = null;
    row.validation_error = null;
    await this.servers.save(row);
    this.logger.log(`wrote mcp server org=${orgId} scope=${dbScope} name=${name}`);
  }

  async setSecret(
    orgId: string,
    dbScope: string,
    name: string,
    slot: 'headers' | 'env',
    key: string,
    value: string,
  ): Promise<boolean> {
    const row = await this.servers.findOne({
      where: { org_id: orgId, scope: dbScope, name },
    });
    if (!row) return false;
    const secrets = this.decryptSecrets(row);
    (secrets[slot] ??= {})[key] = value;
    row.secrets_enc = encryptSecret(JSON.stringify(secrets), this.key());
    const config: StoredMcpConfig = row.config ?? {};
    (config[slot] ??= {})[key] = null;
    row.config = config;
    await this.servers.save(row);
    this.logger.log(
      `set mcp secret org=${orgId} scope=${dbScope} name=${name} slot=${slot} key=${key}`,
    );
    return true;
  }

  async delete(orgId: string, dbScope: string, name: string): Promise<void> {
    await this.servers.delete({ org_id: orgId, scope: dbScope, name });
    this.logger.log(`deleted mcp server org=${orgId} scope=${dbScope} name=${name}`);
  }

  async recordValidation(
    orgId: string,
    dbScope: string,
    name: string,
    result: { discoveredTools?: string[]; error?: string },
  ): Promise<void> {
    const row = await this.servers.findOne({
      where: { org_id: orgId, scope: dbScope, name },
    });
    if (!row) return;
    row.discovered_tools = result.error ? null : (result.discoveredTools ?? []);
    row.validation_error = result.error ?? null;
    row.last_validated_at = new Date();
    await this.servers.save(row);
  }

  async rowsForTurn(orgId: string, repoId: string): Promise<McpServerEntity[]> {
    return this.servers.find({
      where: [
        { org_id: orgId, scope: ORG_SCOPE },
        { org_id: orgId, scope: repoId },
      ],
    });
  }

  async rawRow(orgId: string, dbScope: string, name: string): Promise<McpServerEntity | null> {
    return this.servers.findOne({
      where: { org_id: orgId, scope: dbScope, name },
    });
  }

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
      for (const [k, v] of Object.entries(r.config.headers ?? {}))
        if (v === null && filled.headers?.[k] == null) slots.push(`header:${k}`);
      for (const [k, v] of Object.entries(r.config.env ?? {}))
        if (v === null && filled.env?.[k] == null) slots.push(`env:${k}`);
      if (slots.length > 0)
        out.push({
          name: r.name,
          scope: McpServerStore.fromDbScope(r.scope),
          slots,
        });
    }
    return out;
  }

  async authFailingServers(
    orgId: string,
    repoId: string,
  ): Promise<
    {
      name: string;
      scope: 'org' | string;
      authKind: McpAuthKind;
      reason: string;
    }[]
  > {
    const rows = await this.rowsForTurn(orgId, repoId);
    const out: {
      name: string;
      scope: 'org' | string;
      authKind: McpAuthKind;
      reason: string;
    }[] = [];
    for (const r of rows) {
      if (!r.enabled) continue;
      if (r.validation_error == null) continue;
      out.push({
        name: r.name,
        scope: McpServerStore.fromDbScope(r.scope),
        authKind: r.auth_kind,
        reason: r.validation_error,
      });
    }
    return out;
  }

  async needsOAuthConnect(
    orgId: string,
    repoId: string,
  ): Promise<{ name: string; scope: 'org' | string }[]> {
    const rows = await this.rowsForTurn(orgId, repoId);
    return rows
      .filter((r) => r.enabled && r.auth_kind === 'oauth' && !this.oauthHasToken(r))
      .map((r) => ({
        name: r.name,
        scope: McpServerStore.fromDbScope(r.scope),
      }));
  }

  decryptSecrets(row: McpServerEntity): McpSecretValues {
    if (!row.secrets_enc) return {};
    return JSON.parse(decryptSecret(row.secrets_enc, this.key())) as McpSecretValues;
  }

  readOAuthBlob(row: McpServerEntity): McpOAuthBlob {
    if (!row.oauth_enc) return {};
    return JSON.parse(decryptSecret(row.oauth_enc, this.key())) as McpOAuthBlob;
  }

  private oauthHasToken(r: McpServerEntity): boolean {
    if (r.auth_kind !== 'oauth' || r.oauth_enc == null) return false;
    try {
      const accessToken = this.readOAuthBlob(r).tokens?.['access_token'];
      return typeof accessToken === 'string' && accessToken.length > 0;
    } catch {
      return false;
    }
  }

  async writeOAuthBlob(
    orgId: string,
    dbScope: string,
    name: string,
    blob: McpOAuthBlob,
    opts?: { validationError?: string | null },
  ): Promise<boolean> {
    const row = await this.servers.findOne({
      where: { org_id: orgId, scope: dbScope, name },
    });
    if (!row) return false;
    row.oauth_enc = encryptSecret(JSON.stringify(blob), this.key());
    if (opts && 'validationError' in opts) row.validation_error = opts.validationError ?? null;
    await this.servers.save(row);
    return true;
  }
}
