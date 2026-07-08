import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity, WorkspaceSkillEntity } from '../persistence/entities';
import { SkillResolver } from './skill-resolver.service';
import { SkillsController } from './skills.controller';
import { WorkspaceSkillStore } from './workspace-skill.store';

/**
 * The skills layer — user/brain-defined skills (Org/Repo tiers) + the `SkillResolver` seam the brain and
 * driver turn-assembly paths read through to thread `RunEngineArgs.skills`. `@Global` (like `McpModule`)
 * so those factories inject `SkillResolver` with zero per-module import churn.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([WorkspaceSkillEntity, RepoEntity], DB_CONNECTION)],
  controllers: [SkillsController],
  providers: [WorkspaceSkillStore, SkillResolver],
  exports: [WorkspaceSkillStore, SkillResolver],
})
export class SkillsModule {}
