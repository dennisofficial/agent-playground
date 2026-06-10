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
import { AdminTokenGuard } from './admin-token.guard';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';

/** Admin CRUD for the project registry (which GitHub repo each project's code flows to). */
@Controller('projects')
@UseGuards(AdminTokenGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tokens: GithubTokenStore,
  ) {}

  private async assertKnownToken(tokenName?: string | null): Promise<void> {
    if (!tokenName) return;
    const known = await this.tokens.listMeta();
    if (!known.some((t) => t.name === tokenName)) {
      throw new BadRequestException(`Unknown token "${tokenName}" — store it first (POST /tokens).`);
    }
  }

  @Post()
  async create(@Body() dto: CreateProjectDto) {
    await this.assertKnownToken(dto.tokenName);
    try {
      return await this.projects.create(dto);
    } catch (err) {
      if (err instanceof ProjectConflictError) throw new ConflictException(err.message);
      throw err;
    }
  }

  @Get()
  list() {
    return this.projects.list();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const rec = await this.projects.get(id);
    if (!rec) throw new NotFoundException(`No project "${id}".`);
    return rec;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateProjectDto) {
    await this.assertKnownToken(dto.tokenName);
    const rec = await this.projects.update(id, dto);
    if (!rec) throw new NotFoundException(`No project "${id}".`);
    return rec;
  }
}
