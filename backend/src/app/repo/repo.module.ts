import { CreateModule } from '@workspace/nestjs-core';
import { REALTIME_MODEL, realtimeModelProvider } from '../../_lib/realtime/realtime.tokens';
import { GithubModule } from '../github/github.module';
import { OrganizationMemberRepo } from '../org/entities/organization-member.entity';
import { OrgModule } from '../org/org.module';
import { Repo, RepoRepo } from './entities/repo.entity';
import { OrgRepoController } from './org-repo.controller';
import { RepoController } from './repo.controller';
import { buildRepoRealtimeModel } from './repo.realtime';
import { RepoService } from './repo.service';

@CreateModule({
  // GithubModule supplies the real GITHUB_ACCESS_PORT binding (repo validation + live branches).
  imports: [OrgModule, GithubModule],
  entities: [{ entity: Repo, repoClass: RepoRepo }],
  services: [RepoService],
  controllers: [OrgRepoController, RepoController],
  providers: [
    // Contribute the `repos` realtime model to the engine (aggregated by RealtimeModule.forRoot).
    realtimeModelProvider(
      (members: OrganizationMemberRepo) => [buildRepoRealtimeModel(members)],
      [OrganizationMemberRepo],
    ),
  ],
  exports: [REALTIME_MODEL],
})
export class RepoModule {}
