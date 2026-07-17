import { CreateModule } from '@workspace/nestjs-core';
import { REALTIME_MODEL, realtimeModelProvider } from '../../_lib/realtime/realtime.tokens';
import { OrganizationMemberRepo } from '../org/entities/organization-member.entity';
import { OrgModule } from '../org/org.module';
import { Repo, RepoRepo } from './entities/repo.entity';
import { OrgRepoController } from './org-repo.controller';
import { GITHUB_ACCESS_PORT, NoopGithubAccess } from './ports/github-access.port';
import { RepoController } from './repo.controller';
import { buildRepoRealtimeModel } from './repo.realtime';
import { RepoService } from './repo.service';

@CreateModule({
  imports: [OrgModule],
  entities: [{ entity: Repo, repoClass: RepoRepo }],
  services: [RepoService],
  controllers: [OrgRepoController, RepoController],
  providers: [
    // Default GitHub binding until the GitHub module lands (see app/github/HANDOFF.md).
    { provide: GITHUB_ACCESS_PORT, useClass: NoopGithubAccess },
    // Contribute the `repos` realtime model to the engine (aggregated by RealtimeModule.forRoot).
    realtimeModelProvider(
      (members: OrganizationMemberRepo) => [buildRepoRealtimeModel(members)],
      [OrganizationMemberRepo],
    ),
  ],
  exports: [REALTIME_MODEL],
})
export class RepoModule {}
