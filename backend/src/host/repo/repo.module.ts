import { PgbaseModule } from '@lib/pgbase/pgbase.module';
import { CreateModule } from '@dltech/nestjs-core';
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
    // Exports ScopedDb, which RepoService injects for every Repo read/write.
    PgbaseModule,
  ],
  services: [RepoService],
  controllers: [OrgRepoController, RepoController],
})
export class RepoModule {}
