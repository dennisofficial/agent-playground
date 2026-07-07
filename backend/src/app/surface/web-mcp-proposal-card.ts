/**
 * Web MCP-PROPOSAL card payload — the owner-approvable recommendation the repo-onboarding brain poses via
 * the `propose_mcp_servers` tool once it has grounded the repo's stack. The brain never writes an MCP
 * server directly (that's an owner-only Administer action); it POSTs this card listing a stack-matched set,
 * and the operator/owner reviews + approves it at the owner-gated
 * `…/jobs/:jobId/mcp-proposals/:requestId/approve` endpoint, which commits each server to `McpServerStore`
 * on the THREAD's repo scope. The card carries only the NON-secret definition (transport, url/command/args,
 * header/env NAMES + which slots need a secret) — never a secret value; those are collected afterwards via
 * the `request_secret` MCP target. Any secret value is therefore never part of this card, the transcript,
 * or brain tool I/O.
 *
 * Pure — no I/O, no NestJS. Mirrors `web-secret-input-card.ts` / `web-file-request-card.ts` and is
 * deliberately VALUE-FREE. Per-card lifecycle (no thread pointer): `proposed → approved (approved_at)`.
 */
import type { McpSurface } from '../persistence/entities';

/** One proposed server in a proposal card — the non-secret definition only (no header/env VALUES). */
export interface McpProposalServer {
  /** Tool namespace (`mcp__<name>__…`); must not collide with a reserved system server. */
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  /** Remote (http/sse) endpoint. */
  url?: string;
  /** stdio launch command + args. */
  command?: string;
  args?: string[];
  /**
   * Header entries for a remote server. `secret:true` marks a slot the owner fills AFTER approval (via
   * `request_secret`) — a secret entry NEVER carries a `value`. A non-secret entry may carry a static
   * `value` (e.g. an API-version header) since it isn't a credential.
   */
  headers?: { name: string; secret?: boolean; value?: string }[];
  /** Env-var entries for a stdio server; same secret/non-secret value rule as {@link headers}. */
  env?: { name: string; secret?: boolean; value?: string }[];
  /** Which surfaces the server attaches to (defaults to `['brain','build']` at commit). */
  surfaces?: McpSurface[];
  /** The brain's one-line rationale for why this server suits the repo's stack (shown to the operator). */
  reason?: string;
}

/** A rendered MCP-proposal card — posted to the surface transcript + persisted as a durable card row. */
export interface WebMcpProposalCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'mcp_proposal_card';
  jobId: string;
  /** Stable key for this proposal (the card row's `ts`); the approve POST echoes it back. */
  requestId: string;
  /** The repo the servers will be registered on (display only — the commit re-derives scope from the thread). */
  repoId: string;
  /** The proposed servers (non-secret definitions). */
  servers: McpProposalServer[];
  /**
   * ISO-8601 time the OWNER approved and the servers were committed to `McpServerStore`. Its presence is the
   * terminal "approved" state; the web client then renders a compact "✓ registered" state.
   */
  approved_at?: string;
  /** Server names actually committed on approval (for the rendered confirmation state). */
  committed?: string[];
  /** ISO-8601 time the owner dismissed the proposal without approving (optional — frontend affordance). */
  dismissed_at?: string;
}

/** Build a `WebMcpProposalCard` from the brain's validated `propose_mcp_servers` args. */
export function webMcpProposalCard(input: {
  jobId: string;
  requestId: string;
  repoId: string;
  servers: McpProposalServer[];
}): WebMcpProposalCard {
  return {
    type: 'mcp_proposal_card',
    jobId: input.jobId,
    requestId: input.requestId,
    repoId: input.repoId,
    servers: input.servers,
  };
}
