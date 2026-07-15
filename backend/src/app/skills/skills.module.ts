import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GitModule } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity, WorkspaceSkillEntity } from '../persistence/entities';
import { ManagedSkillSyncService } from './managed-skill-sync.service';
import { SkillFileWriter } from './skill-file-writer.service';
import { SkillInstallerService } from './skill-installer.service';
import { SkillResolver } from './skill-resolver.service';
import { SkillUpdaterService } from './skill-updater.service';
import { SkillsController } from './skills.controller';
import { SystemSkillResolver } from './system-skill-resolver.service';
import { WorkspaceSkillStore } from './workspace-skill.store';

/**
 * The skills layer — user/brain-defined skills (Org/Repo tiers) + the code-defined System tier
 * (`SystemSkillResolver`, display-only — `SkillResolver` merges the same registry into what actually
 * attaches to a turn) + the `SkillResolver` seam the brain and driver turn-assembly paths read through to
 * thread `RunEngineArgs.skills`, plus the git installer/updater (P2) and the git-managed system-tier sync
 * (`ManagedSkillSyncService`, the global org-agnostic counterpart of `SkillUpdaterService`). `@Global`
 * (like `McpModule`) so those factories — and `JobLifecycleService` for `SkillUpdaterService.reconcileOrgAsync`
 * — inject this module's providers with zero per-module import churn. `GitModule` isn't itself `@Global`, so
 * it's imported here for `LocalGitService` (installer/updater/sync clone + `ls-remote`).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([WorkspaceSkillEntity, RepoEntity], DB_CONNECTION),
    GitModule,
  ],
  controllers: [SkillsController],
  providers: [
    WorkspaceSkillStore,
    SkillResolver,
    SkillFileWriter,
    SkillInstallerService,
    SkillUpdaterService,
    ManagedSkillSyncService,
    SystemSkillResolver,
  ],
  exports: [
    WorkspaceSkillStore,
    SkillResolver,
    SkillFileWriter,
    SkillInstallerService,
    SkillUpdaterService,
    ManagedSkillSyncService,
    SystemSkillResolver,
  ],
})
export class SkillsModule {}
