import type { ResolvedAgentTools } from '../skills/skill.types';

/**
 * DI token for the per-agent run-time tool provider — the cheap synchronous lookup the engines do at
 * run time to learn an employee's resolved skills + MCP servers.
 *
 * The seam exists so the engines DON'T depend on the concrete, DB-backed `EngineHomeProvisioner`:
 *  - HOST binds this to `EngineHomeProvisioner` (code-declared ∪ Postgres grants, materialized homes).
 *  - The in-container DAEMON (no DB) binds a provider primed from the inputs the host ships it.
 * Both expose the same `forAgent()` shape, so the engines are byte-identical across host and daemon.
 */
export const AGENT_TOOLS_PROVIDER = Symbol('AGENT_TOOLS_PROVIDER');

/** What every engine consumes at run time: a synchronous, already-resolved per-agent tool lookup. */
export interface IAgentToolsProvider {
  /** This employee's resolved skills + MCP servers (empty for an un-provisioned employee). */
  forAgent(agentId: string): ResolvedAgentTools;
}
