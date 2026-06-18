import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { GithubToken, Project } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { GithubApiService } from './github-api.service';
import { GithubTokenStore } from './github-token-store';
import { ProjectStore } from './project-store';
import { SecretCipher } from './secret-cipher';

/**
 * The project registry + GitHub token store — a SLIM module composable by BOTH the harness (via
 * WorkspacesModule/ToolsModule) and the api app (admin REST), with zero imports from the rest of
 * the harness. Requires the hosting app's @Global DatabaseModule + EnvModule.
 *
 * Everything sits under `services:` (CreateModule's auto-exported bucket) — a plain `providers:`
 * entry would not be exported and downstream DI would fail.
 */
@CreateModule({
  imports: [TypeOrmModule.forFeature([Project, GithubToken])],
  services: [
    SecretCipher,
    GithubApiService,
    {
      provide: ProjectStore,
      inject: [getRepositoryToken(Project)],
      useFactory: (projects: Repository<Project>) => new ProjectStore(projects),
    },
    {
      provide: GithubTokenStore,
      inject: [getRepositoryToken(GithubToken), SecretCipher, ProjectStore],
      useFactory: (
        tokens: Repository<GithubToken>,
        cipher: SecretCipher,
        projects: ProjectStore,
      ) => new GithubTokenStore(tokens, cipher, projects),
    },
  ],
})
export class ProjectsModule {}
