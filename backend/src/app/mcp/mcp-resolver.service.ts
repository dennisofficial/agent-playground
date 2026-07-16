import { Injectable } from '@nestjs/common';
import type { ResolvedMcpServer } from '@shared/engine/engine.types';
import type { McpServerEntity, McpSurface } from '../persistence/entities';
import { McpOAuthService } from './mcp-oauth.service';
import { McpServerStore } from './mcp-server.store';

/**
 * The turn seam for user-defined MCP servers — the analogue of `CredentialResolver` for MCP config.
 * Given a turn's org, repo, and surface, it returns the fully-RESOLVED servers (secret header/env values
 * inlined) to thread onto `RunEngineArgs.userMcpServers`. Injected by the brain + driver turn-assembly
 * paths (a `@Global` module, so no per-module import churn), exactly like `CredentialResolver`.
 *
 * Precedence: a repo-scoped server OVERRIDES an org-scoped server of the same `name` — repo config wins,
 * so a repo can point a shared server name at a different endpoint/token.
 */
@Injectable()
export class McpResolver {
  constructor(
    private readonly store: McpServerStore,
    private readonly oauth: McpOAuthService,
  ) {}

  /**
   * Resolve every enabled server whose `surfaces` include `surface`, for this org + repo, with repo scope
   * overriding org scope by name. Returns `[]` when there are none (the common path — no secrets touched).
   */
  async resolveForTurn(
    orgId: string,
    repoId: string,
    surface: McpSurface,
  ): Promise<ResolvedMcpServer[]> {
    const rows = await this.store.rowsForTurn(orgId, repoId);
    if (rows.length === 0) return [];

    // Repo scope wins on a name collision: seed with org rows, then let repo rows overwrite by name.
    const byName = new Map<string, McpServerEntity>();
    for (const r of rows) {
      if (!r.enabled) continue;
      if (!r.surfaces.includes(surface)) continue;
      const winner = byName.get(r.name);
      // A repo-scoped row (scope !== '*') always beats an org-scoped one; otherwise first-seen org wins.
      if (!winner || (winner.scope === '*' && r.scope !== '*'))
        byName.set(r.name, r);
    }

    const out: ResolvedMcpServer[] = [];
    for (const row of byName.values()) out.push(await this.materialize(row));
    return out;
  }

  /**
   * Resolve the UNION of every enabled server for this org + repo across ALL surfaces (no surface filter),
   * repo scope overriding org scope by name — the input to the per-sandbox MCP HUB, which holds one live
   * connection per server for the sandbox's whole lifetime (surface filtering stays a per-turn concern: the
   * hub holds the union; each turn's `resolveForTurn` picks the surface subset that turn actually exposes).
   * Secrets inlined (the config lands on the durable `/.atlas`, same trust boundary as the agent home).
   */
  async resolveForSandbox(
    orgId: string,
    repoId: string,
  ): Promise<ResolvedMcpServer[]> {
    const rows = await this.store.rowsForTurn(orgId, repoId);
    if (rows.length === 0) return [];

    const byName = new Map<string, McpServerEntity>();
    for (const r of rows) {
      if (!r.enabled) continue;
      const winner = byName.get(r.name);
      if (!winner || (winner.scope === '*' && r.scope !== '*'))
        byName.set(r.name, r);
    }

    const out: ResolvedMcpServer[] = [];
    for (const row of byName.values()) out.push(await this.materialize(row));
    return out;
  }

  /**
   * Inline the decrypted secret values into a plain `ResolvedMcpServer` (the wire shape for the spec). For an
   * `auth_kind='oauth'` server the host-resolved (refreshed-if-needed) access token is added as an
   * `Authorization: Bearer …` header — so the in-sandbox hub connects with it exactly like a static header and
   * needs no OAuth code. A server whose token can't be resolved (needs re-auth) simply carries no Authorization
   * header; the hub's `tools/list` then surfaces the auth failure and the console shows "needs re-auth".
   */
  private async materialize(row: McpServerEntity): Promise<ResolvedMcpServer> {
    const secrets = this.store.decryptSecrets(row);
    const server: ResolvedMcpServer = {
      name: row.name,
      transport: row.transport,
    };

    if (row.transport === 'stdio') {
      if (row.config.command) server.command = row.config.command;
      if (row.config.args && row.config.args.length > 0)
        server.args = row.config.args;
      const env = this.inline(row.config.env, secrets.env);
      if (env) server.env = env;
    } else {
      if (row.config.url) server.url = row.config.url;
      const headers = this.inline(row.config.headers, secrets.headers);
      if (headers) server.headers = headers;
      if (row.auth_kind === 'oauth') {
        const token = await this.oauth.currentAccessToken(row);
        if (token) (server.headers ??= {})['Authorization'] = `Bearer ${token}`;
      }
    }
    return server;
  }

  /** Merge a config slot (with `null` secret placeholders) + its decrypted values into one map. */
  private inline(
    slot: Record<string, string | null> | undefined,
    secretValues: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!slot) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(slot)) {
      const resolved = v === null ? secretValues?.[k] : v;
      if (resolved !== undefined) out[k] = resolved;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
}
