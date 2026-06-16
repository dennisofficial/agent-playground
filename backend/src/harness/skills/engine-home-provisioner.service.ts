import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineHomeDir } from '../engines/engine-home';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeContext } from '../employees/employee-context';
import type { EmployeeDefinition } from '../employees/employee.types';
import { EmployeeMcpStore } from '../employee-skills/employee-mcp.store';
import { EmployeeSkillStore } from '../employee-skills/employee-skill.store';
import { SkillLoaderService } from './skill-loader.service';
import type {
  LoadedSkill,
  McpServerConfig,
  SkillSource,
} from './skill.types';

/** What an engine needs at run time for one employee: which skills to enable and the MCP servers. */
export interface ResolvedAgentTools {
  /** Resolved skill names — Claude enables these natively via its `skills` option. */
  skillNames: string[];
  /** A pre-rendered skills listing for the PROMPT-LEVEL engines (codex/langgraph have no native skill
   * packages) — empty when the employee has no skills. */
  skillsPrompt: string;
  mcpServers: ReadonlyArray<McpServerConfig>;
}

const EMPTY: ResolvedAgentTools = {
  skillNames: [],
  skillsPrompt: '',
  mcpServers: [],
};

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
    private readonly skillStore: EmployeeSkillStore,
    private readonly mcpStore: EmployeeMcpStore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcileAll();
  }

  /**
   * (Re)materialize EVERY employee — not just those that currently declare tools — so an employee
   * whose list dropped to empty still has its stale home cleaned (the home is an exact MIRROR of the
   * declared ∪ granted set, never an append-only pile). Runs at boot and as the catch-up sweep when
   * the grant-change listener (re)connects (covers any NOTIFY missed while it was disconnected).
   */
  async reconcileAll(): Promise<void> {
    const root = this.env.get('AGENT_HOME_ROOT');
    const ctx = this.employees.context();
    for (const emp of this.employees.list()) await this.provision(emp, ctx, root);
  }

  /**
   * Re-resolve ONE employee and re-materialize its homes — the grant-change listener calls this
   * REACTIVELY when a row in `employee_skills`/`employee_mcp_servers` changes (the DB trigger fires
   * `NOTIFY employee_tools_changed, '<employeeId>'`), so an add/remove via the admin REST, a direct
   * SQL edit, or `db:seed` reflects on the employee's next engine turn with NO restart and NO poll.
   * Same exact-mirror semantics as boot.
   */
  async reconcile(employeeId: string): Promise<void> {
    const emp = this.employees.list().find((e) => e.id === employeeId);
    if (!emp) {
      this.logger.warn(`reconcile: unknown employee "${employeeId}"`);
      return;
    }
    await this.provision(emp, this.employees.context(), this.env.get('AGENT_HOME_ROOT'));
  }

  /** The DB-granted skills + MCP for an employee (global tier). */
  private async resolveGrants(emp: EmployeeDefinition): Promise<{
    skillSources: ReadonlyArray<SkillSource>;
    mcpServers: ReadonlyArray<McpServerConfig>;
  }> {
    const [skills, mcp] = await Promise.all([
      this.skillStore.listForEmployee(emp.id),
      this.mcpStore.listForEmployee(emp.id),
    ]);
    return {
      skillSources: skills.map((s) => s.source),
      mcpServers: mcp.map((m) => m.config),
    };
  }

  /** Resolve an employee's tool set (code-declared ∪ DB grants) and make its per-engine homes an
   * exact mirror of it. */
  private async provision(
    emp: EmployeeDefinition,
    ctx: EmployeeContext,
    root: string | undefined,
  ): Promise<void> {
    const resolvedGrants = await this.resolveGrants(emp);
    const skillSources = [
      ...(emp.skills ?? []),
      ...resolvedGrants.skillSources,
    ];
    // Code-declared and DB-granted lists can overlap (same skill/server name) — DEDUPE by name so a
    // duplicate doesn't (a) crash `writeClaudeHome` with an EEXIST on the second symlink to the same
    // `skills/<name>`, or (b) emit a duplicate `[mcp_servers.<name>]` block in codex's config.toml.
    // First occurrence wins (declared before granted).
    const mcpServers = dedupeByKey(
      [...(emp.mcpServers ?? []), ...resolvedGrants.mcpServers],
      (s) => s.name,
    );
    const skills = dedupeByKey(
      await this.loader.resolve(skillSources),
      (s) => s.name,
    );
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
      // langgraph: in-process, no subprocess home — skills go into the system prompt and MCP binds
      // as LangChain tools at agent build time (the engine reads `forAgent()` directly).
    }

    this.byAgent.set(emp.id, {
      skillNames: skills.map((s) => s.name),
      skillsPrompt: skills.length ? renderSkillsMarkdown(skills) : '',
      mcpServers,
    });
    if (skills.length || mcpServers.length)
      this.logger.log(
        `Provisioned ${emp.id} (${[...engines].join(', ')}): ${skills.length} skill(s), ${mcpServers.length} MCP server(s)`,
      );
  }

  /** What the engines pass at run time for this employee (empty for un-provisioned employees). */
  forAgent(agentId: string): ResolvedAgentTools {
    return this.byAgent.get(agentId) ?? EMPTY;
  }

  /** Make the claude config dir's `skills/` folder an exact mirror of `skills` — the whole folder is
   * rebuilt so a skill removed from the set has its symlink pruned (not left orphaned). Idempotent. */
  private writeClaudeHome(home: string, skills: LoadedSkill[]): void {
    const skillsDir = join(home, 'skills');
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(skillsDir, { recursive: true });
    for (const skill of skills) {
      symlinkSync(skill.dir, join(skillsDir, skill.name), 'dir');
    }
  }

  /** Mirror codex's `config.toml` (MCP) + `AGENTS.md` (skills listing) in CODEX_HOME — written when
   * non-empty, DELETED when empty so a cleared list doesn't leave a stale file behind. Idempotent. */
  private writeCodexHome(
    home: string,
    mcpServers: ReadonlyArray<McpServerConfig>,
    skills: LoadedSkill[],
  ): void {
    const configToml = join(home, 'config.toml');
    if (mcpServers.length)
      writeFileSync(configToml, renderCodexMcpToml(mcpServers));
    else rmSync(configToml, { force: true });

    const agentsMd = join(home, 'AGENTS.md');
    if (skills.length) writeFileSync(agentsMd, renderSkillsMarkdown(skills));
    else rmSync(agentsMd, { force: true });
  }
}

/** Keep the FIRST item per key, preserving order. */
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
