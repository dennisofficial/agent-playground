import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import type { Repository } from 'typeorm';
import { GithubModule } from '../github/github.module';
import { OrganizationMember } from '../org/entities/organization-member.entity';
import { OrgModule } from '../org/org.module';
import { Repo, RepoRepo } from './entities/repo.entity';
import { OrgRepoController } from './org-repo.controller';
import { RepoController } from './repo.controller';
import { buildRepoRealtimeModel } from './repo.realtime';
import { RepoService } from './repo.service';

@CreateModule({
  imports: [
    OrgModule,
    // GithubModule supplies the real GITHUB_ACCESS_PORT binding (repo validation + live branches).
    GithubModule,
    // Contribute the `repos` realtime model. Members repo comes from TypeOrmModule.forFeature so the
    // contribution module is self-contained.
    PgRealtimeModule.forFeature({
      imports: [TypeOrmModule.forFeature([OrganizationMember])],
      inject: [getRepositoryToken(OrganizationMember)],
      useFactory: (members: Repository<OrganizationMember>) => [buildRepoRealtimeModel(members)],
    }),
  ],
  entities: [{ entity: Repo, repoClass: RepoRepo }],
  services: [RepoService],
  controllers: [OrgRepoController, RepoController],
})
export class RepoModule {}
