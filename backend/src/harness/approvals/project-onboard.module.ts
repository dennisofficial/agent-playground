import { CreateModule } from '@workspace/nestjs-core';
import { ProjectsModule } from '../projects/projects.module';
import {
  ProjectOnboardService,
  ProjectRegistrar,
} from './project-onboard.service';

/**
 * The shared project-onboarding core (resolve/probe/register + outbound `present()`). A tiny module —
 * the twin of `SuggestionModule` — so the `onboard_project` tool (ToolsModule) injects ONE
 * `ProjectOnboardService`. Depends only on ProjectsModule (ProjectStore + GithubTokenStore +
 * GithubApiService); `PROJECT_ONBOARD_PRESENTER` is bound `@Global` by the hosting surface and
 * injected `@Optional`, so no surface import is needed.
 */
@CreateModule({
  imports: [ProjectsModule],
  services: [ProjectRegistrar, ProjectOnboardService],
  exports: [ProjectRegistrar, ProjectOnboardService],
})
export class ProjectOnboardModule {}
