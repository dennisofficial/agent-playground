import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ProjectConflictError,
  ProjectStore,
} from '../../harness/projects/project-store';
import { GithubTokenStore } from '../../harness/projects/github-token-store';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';

/** Admin CRUD for the project registry (which GitHub repo each project's code flows to). */
@Controller('tenants/:teamId/projects')
@UseGuards(AdminAuthGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tokens: GithubTokenStore,
  ) {}

  private async assertKnownToken(
    teamId: string,
    tokenName?: string | null,
  ): Promise<void> {
    if (!tokenName) return;
    const known = await this.tokens.listMeta(teamId);
    if (!known.some((t) => t.name === tokenName)) {
      throw new BadRequestException(
        `Unknown token "${tokenName}" — store it first (POST /tokens).`,
      );
    }
  }

  @Post()
  async create(@Param('teamId') teamId: string, @Body() dto: CreateProjectDto) {
    await this.assertKnownToken(teamId, dto.tokenName);
    try {
      return await this.projects.create({ ...dto, teamId });
    } catch (err) {
      if (err instanceof ProjectConflictError)
        throw new ConflictException(err.message);
      throw err;
    }
  }

  @Get()
  list(@Param('teamId') teamId: string) {
    return this.projects.list(teamId);
  }

  @Get(':id')
  async get(@Param('teamId') teamId: string, @Param('id') id: string) {
    const rec = await this.projects.get(teamId, id);
    if (!rec) throw new NotFoundException(`No project "${id}".`);
    return rec;
  }

  @Patch(':id')
  async update(
    @Param('teamId') teamId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    await this.assertKnownToken(teamId, dto.tokenName);
    const rec = await this.projects.update(teamId, id, dto);
    if (!rec) throw new NotFoundException(`No project "${id}".`);
    return rec;
  }
}
