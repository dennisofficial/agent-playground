import { Injectable, Logger } from '@nestjs/common';
import type { McpServerEntity } from '../persistence/entities';
import { McpServerStore } from './mcp-server.store';

@Injectable()
export class McpProbeService {
  private readonly logger = new Logger(McpProbeService.name);

  constructor(private readonly store: McpServerStore) {}

  async validate(row: McpServerEntity): Promise<{ discoveredTools?: string[]; error?: string }> {
    try {
      if (row.transport === 'stdio') {
        if (!row.config.command) return { error: 'stdio server has no command' };
        return {};
      }
      const url = row.config.url;
      if (!url) return { error: 'remote server has no url' };
      const secrets = this.store.decryptSecrets(row);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(row.config.headers ?? {})) {
        const resolved = v === null ? secrets.headers?.[k] : v;
        if (resolved !== undefined) headers[k] = resolved;
      }
      return await this.probeRemote(url, headers);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`mcp validate failed name=${row.name}: ${message}`);
      return { error: message };
    }
  }

  private async probeRemote(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ discoveredTools?: string[]; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const rpc = async (method: string, params: unknown, id: number): Promise<unknown> => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${method}`);
        return parseJsonRpc(await res.text());
      };
      await rpc(
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'atlas-mcp-validator', version: '1.0.0' },
        },
        1,
      );
      const tools = await rpc('tools/list', {}, 2);
      const list =
        (tools as { result?: { tools?: Array<{ name?: string }> } })?.result?.tools ?? [];
      return { discoveredTools: list.map((t) => t.name ?? '').filter(Boolean) };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJsonRpc(text: string): unknown {
  let payload = text.trim();
  if (payload.startsWith('event:') || payload.startsWith('data:')) {
    const dataLine = payload.split('\n').find((l) => l.startsWith('data:'));
    payload = dataLine ? dataLine.slice('data:'.length).trim() : payload;
  }
  const obj = JSON.parse(payload) as { error?: { message?: string } };
  if (obj.error) throw new Error(obj.error.message ?? 'JSON-RPC error');
  return obj;
}
