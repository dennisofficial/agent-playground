import { Injectable } from '@nestjs/common';
import { context7Enabled } from '../engine/context7-tools';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { buildSystemMcpServers, type SystemMcpServer } from './system-mcp-registry';

/**
 * Resolves the SYSTEM tier of MCP servers — the built-ins the sandbox attaches on execute turns (the
 * TypeScript LSP, the code-index pair cocoindex/graphify, and Context7) — with their REAL availability for
 * a given org. The companion to {@link McpResolver} (user servers) and {@link McpServerStore}.
 *
 * The names and tool lists come straight from the `engine/*-tools.ts` constants the sandbox actually
 * registers, and each server's `active` flag is computed from the SAME host-side signals the sandbox gates
 * on — so the console shows what the agent genuinely has right now (active vs. needs-config), not a static
 * hand-kept list. Read-only: this tier is code-defined and never written through the store.
 */
@Injectable()
export class SystemMcpResolver {
  constructor(private readonly creds: CredentialResolver) {}

  /** The system servers for an org, each with its live `active` state + a reason when it's off. */
  async resolveForOrg(orgId: string): Promise<SystemMcpServer[]> {
    // cocoindex's semantic search needs cloud embeddings ⇒ gated on the org's OpenAI key (the same signal
    // the driver threads onto a turn as `indexEmbeddingKey`). graphify + the LSP need no key.
    const openaiKeyConfigured = Boolean(await this.creds.openaiKey(orgId));
    return buildSystemMcpServers({
      // Context7 is a deployment-level gate (`CONTEXT7_API_KEY`), not a per-org credential — read the same
      // env flag the in-sandbox bridge reads, so host and container agree on whether it's on.
      context7Configured: context7Enabled(),
      openaiKeyConfigured,
    });
  }
}
