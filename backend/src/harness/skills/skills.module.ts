import { CreateModule } from '@workspace/nestjs-core';
import { EmployeesModule } from '../employees/employees.module';
import { EngineHomeProvisioner } from './engine-home-provisioner.service';
import { SkillLoaderService } from './skill-loader.service';

/**
 * Skills & MCP. Employees declare `skills: SkillSource[]` and `mcpServers` in their definitions; the
 * loader clones/syncs git sources + validates SKILL.md, and the provisioner materializes each
 * employee's per-engine HOME at boot (skills symlinked in, codex MCP written to config.toml) and
 * memoizes `forAgent()` for the engines. Inert until an employee declares skills/MCP.
 */
@CreateModule({
  imports: [EmployeesModule],
  services: [SkillLoaderService, EngineHomeProvisioner],
})
export class SkillsModule {}
