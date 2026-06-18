import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { engineHomeDir } from '../engines/engine-home';
import type { IAgentToolsProvider } from '../engines/agent-tools-provider.port';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeContext } from '../employees/employee-context';
import type { EmployeeDefinition } from '../employees/employee.types';
import { EmployeeMcpStore } from '../employee-skills/employee-mcp.store';
import { EmployeeSkillStore } from '../employee-skills/employee-skill.store';
import { AgentToolSourceResolver } from './agent-tool-source-resolver.service';
import {
  renderSkillsMarkdown,
  writeClaudeHome,
  writeCodexHome,
} from './engine-home-materializer';
import { SkillLoaderService } from './skill-loader.service';
import type { ResolvedAgentTools } from './skill.types';

// `ResolvedAgentTools` moved to the neutral `skill.types` module (so the daemon can import it without
// pulling in this DB-backed file). Re-export here so existing importers don't break.
export type { ResolvedAgentTools } from './skill.types';

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
export class EngineHomeProvisioner
  implements OnApplicationBootstrap, IAgentToolsProvider
{
  private readonly logger = new Logger(EngineHomeProvisioner.name);
  private readonly byAgent = new Map<string, ResolvedAgentTools>();
  // The code-declared ∪ DB-grant union lives in ONE place (`AgentToolSourceResolver`), shared with the
  // dispatch payload the host ships to the daemon. We build it from our already-injected stores rather
  // than injecting it, so the 5-arg constructor (relied on by the unit spec) stays unchanged.
  private readonly sources: AgentToolSourceResolver;

  constructor(
    private readonly employees: EmployeeRegistry,
    private readonly loader: SkillLoaderService,
    private readonly env: EnvService,
    private readonly skillStore: EmployeeSkillStore,
    private readonly mcpStore: EmployeeMcpStore,
  ) {
    this.sources = new AgentToolSourceResolver(
      employees,
      skillStore,
      mcpStore,
    );
  }

  onApplicationBootstrap(): void {
    // Provisioning clones/syncs git skill sources and materializes each employee's per-engine home —
    // network + filesystem work (a `git` sync per git-sourced skill). We do NOT block boot on it: the
    // app and the Slack connection come up immediately and the homes fill in a beat later. Until an
    // employee is provisioned, forAgent() returns empty (a first turn in that brief window simply sees
    // no skills yet); the grant-change listener keeps it current thereafter.
    const startedAt = Date.now();
    const count = this.employees.provisionable().length;
    this.logger.log(
      `Provisioning skill/MCP homes for ${count} employee(s) in the background…`,
    );
    void this.reconcileAll()
      .then(() =>
        this.logger.log(
          `Skill/MCP homes ready for ${count} employee(s) (${Date.now() - startedAt}ms)`,
        ),
      )
      .catch((err) =>
        this.logger.error(
          `Background skill/MCP provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
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
    // provisionable() = the chat roster ∪ the pipeline phase-configs — every identity that runs engine
    // turns and therefore needs a scoped per-engine home (NOT just list(), the chat roster).
    // Provision employees CONCURRENTLY: each writes its own per-engine home dir (no collision), and
    // the loader dedupes/serializes the shared git skill cache, so employees sharing a skills repo
    // await one sync instead of re-fetching it serially. One employee's failure is isolated (logged,
    // not rethrown) so it never aborts the others' provisioning or the boot sweep.
    await Promise.all(
      this.employees.provisionable().map(async (emp) => {
        const startedAt = Date.now();
        try {
          await this.provision(emp, ctx, root);
          this.logger.log(
            `provisioned ${emp.id}: ${this.forAgent(emp.id).skillNames.length} skill(s) (${Date.now() - startedAt}ms)`,
          );
        } catch (err) {
          this.logger.error(
            `provisioning ${emp.id} failed (skipped): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  /**
   * Re-resolve ONE employee and re-materialize its homes — the grant-change listener calls this
   * REACTIVELY when a row in `employee_skills`/`employee_mcp_servers` changes (the DB trigger fires
   * `NOTIFY employee_tools_changed, '<employeeId>'`), so an add/remove via the admin REST, a direct
   * SQL edit, or `db:seed` reflects on the employee's next engine turn with NO restart and NO poll.
   * Same exact-mirror semantics as boot.
   */
  async reconcile(employeeId: string): Promise<void> {
    // byId resolves the roster AND phase-configs — a grant change on a phase-config id reconciles it
    // too (the `employee_skills`/`employee_mcp_servers` id space is generic over both).
    const emp = this.employees.byId(employeeId);
    if (!emp) {
      this.logger.warn(`reconcile: unknown employee "${employeeId}"`);
      return;
    }
    await this.provision(emp, this.employees.context(), this.env.get('AGENT_HOME_ROOT'));
  }

  /** Resolve an employee's tool set (code-declared ∪ DB grants) and make its per-engine homes an
   * exact mirror of it. */
  private async provision(
    emp: EmployeeDefinition,
    ctx: EmployeeContext,
    root: string | undefined,
  ): Promise<void> {
    // The code-declared ∪ DB-grant union (declared-first ordering) comes from the shared resolver —
    // the SAME inputs the host ships to the daemon, so host + daemon materialize identical homes.
    const { skillSources, mcpServers: mcpInputs } =
      await this.sources.forEmployee(emp);
    // Code-declared and DB-granted lists can overlap (same skill/server name) — DEDUPE by name so a
    // duplicate doesn't (a) crash `writeClaudeHome` with an EEXIST on the second symlink to the same
    // `skills/<name>`, or (b) emit a duplicate `[mcp_servers.<name>]` block in codex's config.toml.
    // First occurrence wins (declared before granted).
    const mcpServers = dedupeByKey(mcpInputs, (s) => s.name);
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
        await writeClaudeHome(engineHomeDir(root, 'claude', emp.id), skills);
      else if (kind === 'codex')
        await writeCodexHome(
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
