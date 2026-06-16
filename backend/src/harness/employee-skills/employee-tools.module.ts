import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import {
  EmployeeMcpServer,
  EmployeeSkill,
} from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { EmployeeMcpStore } from './employee-mcp.store';
import { EmployeeSkillStore } from './employee-skill.store';

/**
 * The DB-controlled employee tool grants (skills + MCP servers) — a SLIM module composable by BOTH
 * the harness (SkillsModule → the provisioner reads the stores) and the api app (admin REST), with
 * zero imports from the rest of the harness. Mirrors {@link ProjectsModule}. Requires the hosting
 * app's @Global DatabaseModule.
 *
 * Stores sit under `services:` (CreateModule's auto-exported bucket) so downstream DI can inject them.
 */
@CreateModule({
  imports: [TypeOrmModule.forFeature([EmployeeSkill, EmployeeMcpServer])],
  services: [
    {
      provide: EmployeeSkillStore,
      inject: [getRepositoryToken(EmployeeSkill)],
      useFactory: (repo: Repository<EmployeeSkill>) =>
        new EmployeeSkillStore(repo),
    },
    {
      provide: EmployeeMcpStore,
      inject: [getRepositoryToken(EmployeeMcpServer)],
      useFactory: (repo: Repository<EmployeeMcpServer>) =>
        new EmployeeMcpStore(repo),
    },
  ],
})
export class EmployeeToolsModule {}
