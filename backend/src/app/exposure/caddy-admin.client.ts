import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { request } from 'node:http';

/** Default path of Caddy's admin unix socket (mounted into the backend by the infra compose). */
const DEFAULT_ADMIN_SOCKET = '/srv/atlas/caddy/admin/admin.sock';

/** Ultimate fallback HTTP-server name when discovery can't reach Caddy's config. */
const FALLBACK_SERVER = 'srv0';

/** A single reverse-proxy route to publish: host `<host>` → `<upstream>` (a `host:port` dial). */
export type UpsertRouteInput = {
  /** The route `@id` — stable per preview so an upsert replaces IN PLACE (see `exposure-naming`). */
  id: string;
  host: string;
  /** The upstream dial target, e.g. `atlas-sbx-thread-<jobId>:3000`. */
  upstream: string;
};

type CaddyResponse = { status: number; body: string };

/** The route object Caddy persists — carries the `@id` we stamped so we can list ids back. */
type CaddyRoute = { '@id'?: string };

/**
 * Thin, dependency-free client for Caddy's admin API over its unix socket (Node's built-in `node:http`
 * with `socketPath` — no undici/axios). Drives the dynamic reverse-proxy routes that publish sandbox
 * dev-servers at deterministic preview hosts. Every call is best-effort and tolerant: a connection error
 * (socket missing) or an unexpected status throws a clear error the caller catches, so a Caddy hiccup
 * never crashes the process. Routes are inserted at HEAD so they precede the wildcard 404 fallback.
 */
@Injectable()
export class CaddyAdminClient {
  private readonly logger = new Logger(CaddyAdminClient.name);
  /** The discovered HTTP-server name, cached per instance; re-discovered on a failed lookup. */
  private cachedServerName: string | null = null;

  constructor(private readonly env: EnvService) {}

  private socketPath(): string {
    return this.env.get('CADDY_ADMIN_SOCKET') ?? DEFAULT_ADMIN_SOCKET;
  }

  /** Insert-or-replace the route so `host` reverse-proxies to `upstream`. Idempotent + position-stable. */
  async upsertRoute(input: UpsertRouteInput): Promise<void> {
    const body = JSON.stringify({
      '@id': input.id,
      match: [{ host: [input.host] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: input.upstream }] }],
      terminal: true,
    });
    const existing = await this.call('GET', `/id/${input.id}`);
    if (existing.status === 200) {
      // Present → replace IN PLACE with PATCH (preserves array position, so it stays ahead of the
      // fallback). PATCH strictly replaces an existing @id node; PUT on an @id treats the id as an insert
      // position and Caddy rejects it as a duplicate id (verified live against v2.11).
      this.expectOk(await this.call('PATCH', `/id/${input.id}`, body), `replace route ${input.id}`);
      return;
    }
    if (existing.status !== 404) {
      throw new Error(`caddy GET /id/${input.id} → ${existing.status}: ${existing.body}`);
    }
    // Absent → head-insert so it precedes the wildcard 404 fallback (PUT-at-index prepends).
    const server = await this.serverName();
    this.expectOk(
      await this.call('PUT', `/config/apps/http/servers/${server}/routes/0`, body),
      `insert route ${input.id}`,
    );
  }

  /** Delete a route by `@id`. Tolerates a 404 (already gone). */
  async deleteRoute(id: string): Promise<void> {
    const res = await this.call('DELETE', `/id/${id}`);
    if (res.status === 200 || res.status === 404) return;
    throw new Error(`caddy DELETE /id/${id} → ${res.status}: ${res.body}`);
  }

  /** Every route `@id` currently configured on the HTTP server. */
  async listRouteIds(): Promise<string[]> {
    const server = await this.serverName();
    const res = await this.call('GET', `/config/apps/http/servers/${server}/routes`);
    if (res.status !== 200) {
      throw new Error(`caddy GET routes → ${res.status}: ${res.body}`);
    }
    const routes = (JSON.parse(res.body || '[]') as CaddyRoute[]) ?? [];
    return routes.map((r) => r['@id']).filter((id): id is string => typeof id === 'string');
  }

  /** Delete every route whose `@id` starts with `prefix` (a job's whole preview set). Best-effort. */
  async deleteRoutesByPrefix(prefix: string): Promise<void> {
    const ids = (await this.listRouteIds()).filter((id) => id.startsWith(prefix));
    for (const id of ids) {
      await this.deleteRoute(id).catch((err) =>
        this.logger.debug(`deleteRoute(${id}) failed: ${err}`),
      );
    }
  }

  /**
   * Discover the HTTP-server name from Caddy's config (the server whose `listen` includes `:443`, else
   * the first key, else {@link FALLBACK_SERVER}). Cached per instance; a failed lookup clears the cache
   * so the next call re-discovers.
   */
  private async serverName(): Promise<string> {
    if (this.cachedServerName) return this.cachedServerName;
    try {
      const res = await this.call('GET', '/config/apps/http/servers');
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const servers = JSON.parse(res.body || '{}') as Record<string, { listen?: string[] }>;
      const names = Object.keys(servers);
      const tls = names.find((n) => (servers[n]?.listen ?? []).some((l) => l.endsWith(':443')));
      this.cachedServerName = tls ?? names[0] ?? FALLBACK_SERVER;
      return this.cachedServerName;
    } catch (err) {
      this.cachedServerName = null;
      this.logger.debug(`caddy server discovery failed, using ${FALLBACK_SERVER}: ${err}`);
      return FALLBACK_SERVER;
    }
  }

  private expectOk(res: CaddyResponse, what: string): void {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`caddy ${what} → ${res.status}: ${res.body}`);
    }
  }

  /** One admin-API request over the unix socket. Rejects on a connection error (socket missing/down). */
  private call(method: string, path: string, body?: string): Promise<CaddyResponse> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath(),
          path,
          method,
          headers: {
            'content-type': 'application/json',
            ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
