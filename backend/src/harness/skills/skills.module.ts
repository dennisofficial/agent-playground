import { CreateModule } from '@workspace/nestjs-core';
import { EmployeesModule } from '../employees/employees.module';
import { EmployeeToolsModule } from '../employee-skills/employee-tools.module';
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
  services: [SkillLoaderService, EngineHomeProvisioner, GrantChangeListener],
})
export class SkillsModule {}
