import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineHomeDir } from '../engines/engine-home';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeContext } from '../employees/employee-context';
import type { EmployeeDefinition } from '../employees/employee.types';
import { SkillLoaderService } from './skill-loader.service';
import type { LoadedSkill, McpServerConfig } from './skill.types';

/** What an engine needs at run time for one employee: which skills to enable and the MCP servers. */
export interface ResolvedAgentTools {
  skillNames: string[];
  mcpServers: ReadonlyArray<McpServerConfig>;
}

const EMPTY: ResolvedAgentTools = { skillNames: [], mcpServers: [] };

/**
 * Materializes each employee's per-engine HOME at boot from their declared skills + MCP, so the
 * homes `engineHomeDir` hands the engines are already populated. Skills/MCP are PER EMPLOYEE — this
 * is why the homes can't be shared. The result is memoized so the engines do a cheap `forAgent()`
 * lookup at run time.
 *
 * Materialization by engine:
 *  - claude: each resolved skill is symlinked into `<CLAUDE_CONFIG_DIR>/skills/<name>` (the CLI
 *    discovers them); MCP rides as an in-memory `mcpServers` option the claude engine passes (NOT a
 *    file — that wiring is the remaining step; `forAgent()` already returns the config for it).
 *  - codex: `<CODEX_HOME>/config.toml` gets an `[mcp_servers.*]` block per server (codex reads it
 *    natively, no engine change), plus an `AGENTS.md` listing the skills (prompt-level — codex has
 *    no native skill packages).
 *
 * Derived, gitignored, rebuilt every boot — so it's restart-safe by construction (the only durable
 * dependency is the shared skill cache, which lives under the same base).
 */
@Injectable()
export class EngineHomeProvisioner implements OnApplicationBootstrap {
  private readonly logger = new Logger(EngineHomeProvisioner.name);
  private readonly byAgent = new Map<string, ResolvedAgentTools>();

  constructor(
    private readonly employees: EmployeeRegistry,
    private readonly loader: SkillLoaderService,
    private readonly env: EnvService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const root = this.env.get('AGENT_HOME_ROOT');
    const ctx = this.employees.context();
    for (const emp of this.employees.list()) {
      const sources = emp.skills ?? [];
      const mcpServers = emp.mcpServers ?? [];
      if (sources.length === 0 && mcpServers.length === 0) continue; // nothing to materialize

      const skills = await this.loader.resolve(sources);
      // An employee can run on MORE than one engine — plan/execute specs plus its capability specs
      // (e.g. a Claude planner that self-reviews on Codex). Materialize a per-engine home for EVERY
      // distinct engine its specs use, not just one base engine, so a cross-engine spec isn't left
      // without its skills/MCP home.
      const engines = enginesFor(emp, ctx);
      for (const engine of engines) {
        const kind = engineKind(engine);
        if (kind === 'claude')
          this.writeClaudeHome(engineHomeDir(root, 'claude', emp.id), skills);
        else if (kind === 'codex')
          this.writeCodexHome(
            engineHomeDir(root, 'codex', emp.id),
            mcpServers,
            skills,
          );
        // langgraph: in-process, no subprocess home — skills/MCP prompt-level (not yet wired).
      }

      this.byAgent.set(emp.id, {
        skillNames: skills.map((s) => s.name),
        mcpServers,
      });
      this.logger.log(
        `Provisioned ${emp.id} (${[...engines].join(', ')}): ${skills.length} skill(s), ${mcpServers.length} MCP server(s)`,
      );
    }
  }

  /** What the engines pass at run time for this employee (empty for un-provisioned employees). */
  forAgent(agentId: string): ResolvedAgentTools {
    return this.byAgent.get(agentId) ?? EMPTY;
  }

  /** Symlink each resolved skill dir into the claude config dir's skills/ folder (idempotent). */
  private writeClaudeHome(home: string, skills: LoadedSkill[]): void {
    const skillsDir = join(home, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    for (const skill of skills) {
      const target = join(skillsDir, skill.name);
      rmSync(target, { recursive: true, force: true });
      symlinkSync(skill.dir, target, 'dir');
    }
  }

  /** Write codex's config.toml (MCP) + an AGENTS.md skills listing into CODEX_HOME (idempotent). */
  private writeCodexHome(
    home: string,
    mcpServers: ReadonlyArray<McpServerConfig>,
    skills: LoadedSkill[],
  ): void {
    if (mcpServers.length)
      writeFileSync(join(home, 'config.toml'), renderCodexMcpToml(mcpServers));
    if (skills.length)
      writeFileSync(join(home, 'AGENTS.md'), renderSkillsMarkdown(skills));
  }
}

function engineKind(engine: EWorkerEngineName): 'claude' | 'codex' | null {
  if (engine === EWorkerEngineName.CLAUDE) return 'claude';
  if (engine === EWorkerEngineName.CODEX) return 'codex';
  return null;
}

/** The distinct set of engines an employee runs on — plan + execute specs + every capability spec. */
function enginesFor(
  emp: EmployeeDefinition,
  ctx: EmployeeContext,
): Set<EWorkerEngineName> {
  const engines = new Set<EWorkerEngineName>([
    emp.planEngine(ctx).engine,
    emp.executeEngine(ctx).engine,
  ]);
  for (const cap of emp.capabilities(ctx)) engines.add(cap.spec(ctx).engine);
  return engines;
}

const tomlStr = (v: string): string =>
  `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Render `[mcp_servers.*]` blocks codex reads from CODEX_HOME/config.toml. stdio is fully
 * supported; http is best-effort (codex's streamable-http MCP schema varies by version). */
function renderCodexMcpToml(servers: ReadonlyArray<McpServerConfig>): string {
  const blocks = servers.map((s) => {
    if (s.transport === 'stdio') {
      const lines = [
        `[mcp_servers.${s.name}]`,
        `command = ${tomlStr(s.command)}`,
      ];
      if (s.args?.length)
        lines.push(`args = [${s.args.map(tomlStr).join(', ')}]`);
      if (s.env && Object.keys(s.env).length) {
        lines.push(`[mcp_servers.${s.name}.env]`);
        for (const [k, v] of Object.entries(s.env))
          lines.push(`${k} = ${tomlStr(v)}`);
      }
      return lines.join('\n');
    }
    // http — best-effort; verify against the codex version in use.
    return [`[mcp_servers.${s.name}]`, `url = ${tomlStr(s.url)}`].join('\n');
  });
  return `# Generated by EngineHomeProvisioner — per-employee MCP servers. Do not edit by hand.\n\n${blocks.join('\n\n')}\n`;
}

function renderSkillsMarkdown(skills: LoadedSkill[]): string {
  const items = skills
    .map((s) => `- **${s.name}** — ${s.description} (files at \`${s.dir}\`)`)
    .join('\n');
  return `# Skills available to you\n\nYou have these skills; read a skill's directory for its full instructions before using it.\n\n${items}\n`;
}
