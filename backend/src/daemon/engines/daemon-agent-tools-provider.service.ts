import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { engineHomeDir } from '@harness/engines/engine-home';
import type { IAgentToolsProvider } from '@harness/engines/agent-tools-provider.port';
import {
  renderSkillsMarkdown,
  writeClaudeHome,
  writeCodexHome,
} from '@harness/skills/engine-home-materializer';
import { SkillLoaderService } from '@harness/skills/skill-loader.service';
import type {
  McpServerConfig,
  ResolvedAgentTools,
  SkillSource,
} from '@harness/skills/skill.types';

/** The per-run inputs the host ships the daemon (Phase 5 dispatch payload) — the SAME shape the host
 * `AgentToolSourceResolver.forEmployee()` returns, so host + daemon materialize identical homes. */
export interface AgentToolInputs {
  skillSources: ReadonlyArray<SkillSource>;
  mcpServers: ReadonlyArray<McpServerConfig>;
}

const EMPTY: ResolvedAgentTools = {
  skillNames: [],
  skillsPrompt: '',
  mcpServers: [],
};

/**
 * The DAEMON's `IAgentToolsProvider` — the DB-FREE mirror of the host `EngineHomeProvisioner`.
 *
 * The host provisioner resolves each employee's tools from `code-declared ∪ Postgres grants` at boot
 * and on grant-change NOTIFY. The daemon has NO database, so it can't do that. Instead the host ships
 * the already-resolved INPUTS (`{skillSources, mcpServers}`) in the per-run dispatch payload, and the
 * Phase-5 dispatcher calls `prime(agentId, inputs)` BEFORE each engine run. `prime` does exactly what
 * `EngineHomeProvisioner.provision` does — resolve skills, dedupe, materialize the per-agent claude +
 * codex homes via the extracted (DB-free) materializer, and cache a `ResolvedAgentTools` — and then
 * `forAgent` is the cheap synchronous lookup the verbatim engines do at run time.
 *
 * Both engine homes are materialized regardless of which engine this run uses: it's cheap, idempotent,
 * and keeps the home an exact mirror so a later run of the OTHER engine for the same agent is correct
 * too. (The host knows the engine and writes only the one it needs; the daemon, fed per-run, writes
 * both — harmless and keeps `prime` engine-agnostic.)
 */
@Injectable()
export class DaemonAgentToolsProvider implements IAgentToolsProvider {
  private readonly logger = new Logger(DaemonAgentToolsProvider.name);
  private readonly byAgent = new Map<string, ResolvedAgentTools>();

  constructor(
    private readonly loader: SkillLoaderService,
    private readonly env: EnvService,
  ) {}

  /**
   * Resolve + materialize one agent's tools from the host-shipped inputs, then cache the run-time
   * lookup. Idempotent — re-priming the same agent re-mirrors its homes (a tool set that shrank has
   * its stale symlinks/files pruned, exactly like the host provisioner's exact-mirror semantics).
   * Returns the resolved tools (handy for the dispatcher's logging/payload).
   */
  async prime(
    agentId: string,
    inputs: AgentToolInputs,
  ): Promise<ResolvedAgentTools> {
    const root = this.env.get('AGENT_HOME_ROOT');
    // Code-declared and granted lists can collide on name — dedupe (first wins) so a duplicate
    // doesn't crash `writeClaudeHome` (EEXIST on the second symlink) or emit a duplicate codex block.
    const mcpServers = dedupeByKey(inputs.mcpServers, (s) => s.name);
    const skills = dedupeByKey(
      await this.loader.resolve(inputs.skillSources),
      (s) => s.name,
    );

    // Materialize BOTH engine homes for this agent (see class doc — engine-agnostic, idempotent).
    await writeClaudeHome(engineHomeDir(root, 'claude', agentId), skills);
    await writeCodexHome(
      engineHomeDir(root, 'codex', agentId),
      mcpServers,
      skills,
    );

    const resolved: ResolvedAgentTools = {
      skillNames: skills.map((s) => s.name),
      skillsPrompt: skills.length ? renderSkillsMarkdown(skills) : '',
      mcpServers,
    };
    this.byAgent.set(agentId, resolved);
    this.logger.log(
      `primed ${agentId}: ${skills.length} skill(s), ${mcpServers.length} MCP server(s)`,
    );
    return resolved;
  }

  /**
   * The cheap synchronous run-time lookup the engines do. Returns EMPTY for an un-primed agent rather
   * than throwing — matches the host provisioner's contract (an engine run in the brief pre-provision
   * window simply sees no skills). In the daemon the Phase-5 dispatcher always `prime`s before
   * dispatching, so an empty result here means a dispatch bug, but degrading to "no tools" is safer
   * than crashing a turn.
   */
  forAgent(agentId: string): ResolvedAgentTools {
    return this.byAgent.get(agentId) ?? EMPTY;
  }
}

/** Keep the FIRST item per key, preserving order (mirrors EngineHomeProvisioner.dedupeByKey). */
function dedupeByKey<T>(items: ReadonlyArray<T>, key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
