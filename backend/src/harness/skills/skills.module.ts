import { CreateModule } from '@workspace/nestjs-core';
import { AGENT_TOOLS_PROVIDER } from '../engines/agent-tools-provider.port';
import { EmployeesModule } from '../employees/employees.module';
import { EmployeeToolsModule } from '../employee-skills/employee-tools.module';
import { AgentToolSourceResolver } from './agent-tool-source-resolver.service';
import { EngineHomeProvisioner } from './engine-home-provisioner.service';
import { GrantChangeListener } from './grant-change.listener';
import { SkillLoaderService } from './skill-loader.service';

/**
 * Skills & MCP. An employee's skills/MCP come from byte-stable code constants (`skills`/`mcpServers`)
 * UNIONED with DB-controlled grants (the `employee_skills` / `employee_mcp_servers` tables, set via
 * the admin REST or the `db:seed` seeder). The loader clones/syncs git sources + validates SKILL.md,
 * and the provisioner materializes each employee's per-engine HOME (skills symlinked in, codex MCP
 * to config.toml) and memoizes `forAgent()` for the engines — at boot and REACTIVELY: a DB trigger
 * fires `NOTIFY employee_tools_changed` and `GrantChangeListener` reconciles the affected employee,
 * so DB changes reflect with no restart and no poll.
 */
@CreateModule({
  imports: [EmployeesModule, EmployeeToolsModule],
  services: [
    SkillLoaderService,
    EngineHomeProvisioner,
    GrantChangeListener,
    // The host tool-source resolver (code-declared ∪ DB grants) — the inputs the host ships to the
    // daemon (Phase 5). Exported so the remote-turn dispatcher can read it.
    AgentToolSourceResolver,
    // The engines depend on the DB-free AGENT_TOOLS_PROVIDER port, not the concrete provisioner; on
    // the HOST it IS the provisioner (the daemon binds its own). `services` auto-exports this binding.
    { provide: AGENT_TOOLS_PROVIDER, useExisting: EngineHomeProvisioner },
  ],
})
export class SkillsModule {}
