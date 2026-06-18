import { Injectable } from '@nestjs/common';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import { EmployeeMcpStore } from '../employee-skills/employee-mcp.store';
import { EmployeeSkillStore } from '../employee-skills/employee-skill.store';
import type { McpServerConfig, SkillSource } from './skill.types';

/** The per-agent tool INPUTS — code-declared ∪ DB grants, BEFORE the loader resolves the skill
 * sources to on-disk dirs. This is exactly what the host ships to the daemon (Phase 5): the daemon
 * runs `SkillLoaderService.resolve` + the materializer on these, with no DB of its own. */
export interface AgentToolSources {
  skillSources: SkillSource[];
  mcpServers: McpServerConfig[];
}

/**
 * Resolves an employee's declared ∪ DB-granted tool INPUTS (skill sources + MCP servers) — the union
 * `EngineHomeProvisioner.provision()` used to compute inline. Extracted so two callers share ONE
 * source of truth for the union:
 *  - `EngineHomeProvisioner` (resolves these to dirs + materializes the host homes), and
 *  - the dispatch payload (Phase 5) the host ships to the in-container daemon, which has no DB.
 *
 * This stays HOST-side (it reads Postgres grants); the daemon never calls it.
 */
@Injectable()
export class AgentToolSourceResolver {
  constructor(
    private readonly employees: EmployeeRegistry,
    private readonly skillStore: EmployeeSkillStore,
    private readonly mcpStore: EmployeeMcpStore,
  ) {}

  /** Tool sources for an employee id (roster OR pipeline phase-config — both live in `byId`). Returns
   * empty inputs for an unknown id rather than throwing, mirroring `forAgent`'s empty default. */
  async forAgent(agentId: string): Promise<AgentToolSources> {
    const emp = this.employees.byId(agentId);
    if (!emp) return { skillSources: [], mcpServers: [] };
    return this.forEmployee(emp);
  }

  /** Tool sources for an already-resolved employee (the provisioner already has the definition in
   * hand, so it calls this directly to avoid a redundant `byId` lookup). Code-declared FIRST, then DB
   * grants — preserving the declared-before-granted order the provisioner's dedupe-by-name relies on. */
  async forEmployee(emp: EmployeeDefinition): Promise<AgentToolSources> {
    const [skills, mcp] = await Promise.all([
      this.skillStore.listForEmployee(emp.id),
      this.mcpStore.listForEmployee(emp.id),
    ]);
    return {
      skillSources: [...(emp.skills ?? []), ...skills.map((s) => s.source)],
      mcpServers: [...(emp.mcpServers ?? []), ...mcp.map((m) => m.config)],
    };
  }
}
