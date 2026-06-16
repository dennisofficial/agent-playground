import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { EmployeeMcpStore } from '../../harness/employee-skills/employee-mcp.store';
import { EmployeeSkillStore } from '../../harness/employee-skills/employee-skill.store';
import type { McpServerConfig, SkillSource } from '../../harness/skills/skill.types';
import { AdminTokenGuard } from './admin-token.guard';
import { CreateMcpDto, CreateSkillDto } from './dto/employee-tools.dto';

/**
 * Admin CRUD for DB-controlled employee tool grants (skills + MCP servers, GLOBAL tier). The harness
 * provisioner polls these tables and re-materializes the employee's engine home, so an add/remove
 * here takes effect on the employee's next engine turn with NO restart. Seeders write the same rows.
 */
@UseGuards(AdminTokenGuard)
@Controller('admin/employees')
export class EmployeeToolsController {
  constructor(
    private readonly skills: EmployeeSkillStore,
    private readonly mcp: EmployeeMcpStore,
  ) {}

  // ---- skills ----

  @Get(':employeeId/skills')
  listSkills(@Param('employeeId') employeeId: string) {
    return this.skills.listForEmployee(employeeId);
  }

  @Post(':employeeId/skills')
  addSkill(
    @Param('employeeId') employeeId: string,
    @Body() dto: CreateSkillDto,
  ) {
    const source = toSkillSource(dto);
    return this.skills.add({
      employeeId,
      name: dto.name,
      description: dto.description,
      source,
    });
  }

  @Delete(':employeeId/skills/:id')
  @HttpCode(204)
  async removeSkill(@Param('id') id: string) {
    const ok = await this.skills.remove(Number(id));
    if (!ok) throw new NotFoundException(`No skill grant #${id}.`);
  }

  // ---- mcp servers ----

  @Get(':employeeId/mcp')
  listMcp(@Param('employeeId') employeeId: string) {
    return this.mcp.listForEmployee(employeeId);
  }

  @Post(':employeeId/mcp')
  addMcp(@Param('employeeId') employeeId: string, @Body() dto: CreateMcpDto) {
    return this.mcp.add({ employeeId, config: toMcpConfig(dto) });
  }

  @Delete(':employeeId/mcp/:id')
  @HttpCode(204)
  async removeMcp(@Param('id') id: string) {
    const ok = await this.mcp.remove(Number(id));
    if (!ok) throw new NotFoundException(`No MCP grant #${id}.`);
  }
}

function toSkillSource(dto: CreateSkillDto): SkillSource {
  if (dto.kind === 'git') {
    if (!dto.url) throw new BadRequestException('git skill requires `url`.');
    return {
      kind: 'git',
      url: dto.url,
      ...(dto.ref ? { ref: dto.ref } : {}),
      ...(dto.subPath ? { subPath: dto.subPath } : {}),
    };
  }
  if (!dto.path) throw new BadRequestException('local skill requires `path`.');
  return { kind: 'local', path: dto.path };
}

function toMcpConfig(dto: CreateMcpDto): McpServerConfig {
  if (dto.transport === 'stdio') {
    if (!dto.command)
      throw new BadRequestException('stdio MCP server requires `command`.');
    return {
      name: dto.name,
      transport: 'stdio',
      command: dto.command,
      ...(dto.args ? { args: dto.args } : {}),
      ...(dto.env ? { env: dto.env } : {}),
    };
  }
  if (!dto.url)
    throw new BadRequestException('http MCP server requires `url`.');
  return {
    name: dto.name,
    transport: 'http',
    url: dto.url,
    ...(dto.headers ? { headers: dto.headers } : {}),
  };
}
