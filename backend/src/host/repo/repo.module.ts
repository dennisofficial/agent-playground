import { CreateModule } from '@dltech/nestjs-core';
import { Repo, RepoRepo } from '../../_lib/database/entities/repo.entity';
import { GithubModule } from '../github/github.module';
import { OrgModule } from '../org/org.module';
import { OrgRepoController } from './org-repo.controller';
import { RepoController } from './repo.controller';
import { RepoService } from './repo.service';

@CreateModule({
  imports: [
    OrgModule,
    // GithubModule exports GithubAccessAdapter, injected directly by RepoService (repo validation + live branches).
    GithubModule,
  ],
  entities: [{ entity: Repo, repoClass: RepoRepo }],
  services: [RepoService],
  controllers: [OrgRepoController, RepoController],
})
export class RepoModule {}
