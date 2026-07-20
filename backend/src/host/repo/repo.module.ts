import { CreateModule } from '@workspace/nestjs-core';
import { RLS_CONTEXT, type RlsContextConfig } from '@workspace/nestjs-rls/nest';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import { Repo, RepoRepo } from '../../_lib/database/entities/repo.entity';
import { GithubModule } from '../github/github.module';
import { OrgModule } from '../org/org.module';
import { OrgRepoController } from './org-repo.controller';
import { RepoController } from './repo.controller';
import { buildRepoRealtimeModel } from './repo.realtime';
import { RepoService } from './repo.service';

@CreateModule({
  imports: [
    OrgModule,
    // GithubModule exports GithubAccessAdapter, injected directly by RepoService (repo validation + live branches).
    GithubModule,
    // Contribute the `repos` realtime model. Row-scope comes from Repo's @Rls policy.
    PgRealtimeModule.forFeature({
      inject: [RLS_CONTEXT],
      useFactory: (ctx: RlsContextConfig) => [buildRepoRealtimeModel(ctx.resolveClaims)],
    }),
  ],
  entities: [{ entity: Repo, repoClass: RepoRepo }],
  services: [RepoService],
  controllers: [OrgRepoController, RepoController],
})
export class RepoModule {}
