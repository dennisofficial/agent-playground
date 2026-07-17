import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GitModule } from '../git/git.module';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity, WorkspaceSkillEntity } from '../persistence/entities';
import { ManagedSkillSyncService } from './managed-skill-sync.service';
import { SkillFileWriter } from './skill-file-writer.service';
import { SkillInstallerService } from './skill-installer.service';
import { AnthropicSkillNudgeSelector, SKILL_NUDGE_SELECTOR } from './skill-nudge-llm';
import { SkillResolver } from './skill-resolver.service';
import { SkillUpdaterService } from './skill-updater.service';
import { SkillsController } from './skills.controller';
import { SystemSkillResolver } from './system-skill-resolver.service';
import { WorkspaceSkillStore } from './workspace-skill.store';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([WorkspaceSkillEntity, RepoEntity], DB_CONNECTION), GitModule],
  controllers: [SkillsController],
  providers: [
    WorkspaceSkillStore,
    SkillResolver,
    SkillFileWriter,
    SkillInstallerService,
    SkillUpdaterService,
    ManagedSkillSyncService,
    SystemSkillResolver,
    {
      provide: SKILL_NUDGE_SELECTOR,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver) =>
        new AnthropicSkillNudgeSelector((orgId) => creds.anthropicKey(orgId)),
    },
  ],
  exports: [
    WorkspaceSkillStore,
    SkillResolver,
    SkillFileWriter,
    SkillInstallerService,
    SkillUpdaterService,
    ManagedSkillSyncService,
    SystemSkillResolver,
    SKILL_NUDGE_SELECTOR,
  ],
})
export class SkillsModule {}
