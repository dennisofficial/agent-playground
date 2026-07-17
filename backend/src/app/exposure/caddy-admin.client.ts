import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { request } from 'node:http';

const DEFAULT_ADMIN_SOCKET = '/srv/atlas/caddy/admin/admin.sock';

const FALLBACK_SERVER = 'srv0';

export type UpsertRouteInput = {
  id: string;
  host: string;
  upstream: string;
};

type CaddyResponse = { status: number; body: string };

type CaddyRoute = { '@id'?: string };

@Injectable()
export class CaddyAdminClient {
  private readonly logger = new Logger(CaddyAdminClient.name);
  private cachedServerName: string | null = null;

  constructor(private readonly env: EnvService) {}

  private socketPath(): string {
    return this.env.get('CADDY_ADMIN_SOCKET') ?? DEFAULT_ADMIN_SOCKET;
  }

  async upsertRoute(input: UpsertRouteInput): Promise<void> {
    const body = JSON.stringify({
      '@id': input.id,
      match: [{ host: [input.host] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: input.upstream }] }],
      terminal: true,
    });
    const existing = await this.call('GET', `/id/${input.id}`);
    if (existing.status === 200) {
      this.expectOk(await this.call('PATCH', `/id/${input.id}`, body), `replace route ${input.id}`);
      return;
    }
    if (existing.status !== 404) {
      throw new Error(`caddy GET /id/${input.id} → ${existing.status}: ${existing.body}`);
    }
    const server = await this.serverName();
    this.expectOk(
      await this.call('PUT', `/config/apps/http/servers/${server}/routes/0`, body),
      `insert route ${input.id}`,
    );
  }

  async deleteRoute(id: string): Promise<void> {
    const res = await this.call('DELETE', `/id/${id}`);
    if (res.status === 200 || res.status === 404) return;
    throw new Error(`caddy DELETE /id/${id} → ${res.status}: ${res.body}`);
  }

  async listRouteIds(): Promise<string[]> {
    const server = await this.serverName();
    const res = await this.call('GET', `/config/apps/http/servers/${server}/routes`);
    if (res.status !== 200) {
      throw new Error(`caddy GET routes → ${res.status}: ${res.body}`);
    }
    const routes = (JSON.parse(res.body || '[]') as CaddyRoute[]) ?? [];
    return routes.map((r) => r['@id']).filter((id): id is string => typeof id === 'string');
  }

  async deleteRoutesByPrefix(prefix: string): Promise<void> {
    const ids = (await this.listRouteIds()).filter((id) => id.startsWith(prefix));
    for (const id of ids) {
      await this.deleteRoute(id).catch((err) =>
        this.logger.debug(`deleteRoute(${id}) failed: ${err}`),
      );
    }
  }

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
