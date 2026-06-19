import { CreateModule } from '@workspace/nestjs-core';
import { ChannelModule } from '../channel/channel.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { ChannelProjectLinker } from './channel-project-linker';
import {
  ProjectOnboardService,
  ProjectRegistrar,
} from './project-onboard.service';

/**
 * The shared project-onboarding core (resolve/probe/register + outbound `present()` + channel→repo
 * binding). The twin of `SuggestionModule` — the `onboard_project` tool (ToolsModule) and the Slack
 * onboarding card both inject from here. Harness-only (the slim api app does NOT compose it), so it
 * can pull ChannelModule + MemoryModule for {@link ChannelProjectLinker} (which repoints the channel's
 * project + carries its project-scoped rows). `PROJECT_ONBOARD_PRESENTER` is bound `@Global` by the
 * hosting surface and injected `@Optional`; the linker is presenter-FREE, so the card path can inject
 * it without re-introducing the service↔adapter cycle.
 */
@CreateModule({
  imports: [ProjectsModule, ChannelModule, MemoryModule],
  services: [ProjectRegistrar, ProjectOnboardService, ChannelProjectLinker],
  exports: [ProjectRegistrar, ProjectOnboardService, ChannelProjectLinker],
})
export class ProjectOnboardModule {}
