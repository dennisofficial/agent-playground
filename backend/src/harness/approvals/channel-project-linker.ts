import { Injectable, Logger } from '@nestjs/common';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import { BoardStore } from '../memory/board-store';
import { SemanticMemory } from '../memory/semantic-memory';
import { TaskStore } from '../memory/task-store';
import { ProjectStore } from '../projects/project-store';

/**
 * Binds a Slack channel to its main GitHub project — the missing link between `onboard_project` and
 * the channel's own working project. Presenter-FREE on purpose: BOTH the `onboard_project` tool path
 * ({@link ProjectOnboardService}) and the Slack onboarding-card modal path (`ProjectOnboardCardsService`)
 * call it, and the card service must NOT depend on the outbound presenter (it IS the presenter), so the
 * link logic lives here, depending only on the channel registry + the project-scoped stores. Injecting
 * this never reaches `PROJECT_ONBOARD_PRESENTER`, so there's no service↔adapter DI cycle.
 *
 * Linking repoints `channel.project` from the channel-name slug it registered with to the registered
 * project id, then carries the channel's pre-link project-scoped rows (board tasks, reminders, facts)
 * across so nothing captured under the slug disappears from the bot's default views.
 */
@Injectable()
export class ChannelProjectLinker {
  private readonly logger = new Logger(ChannelProjectLinker.name);

  constructor(
    private readonly channels: ChannelRegistryService,
    private readonly projects: ProjectStore,
    private readonly board: BoardStore,
    private readonly tasks: TaskStore,
    private readonly facts: SemanticMemory,
  ) {}

  /**
   * Make `projectId` the channel's main working repo IF the channel doesn't already have one. Returns
   * `{ linkedAsMain: true }` when it became the channel's project (and pre-link rows were repointed);
   * `false` for a DM, an unknown room, or a channel already linked to a registered repo (the new repo
   * is just a read-only reference in that case).
   */
  async linkChannelProject(input: {
    team: string;
    surfaceId: string;
    projectId: string;
  }): Promise<{ linkedAsMain: boolean }> {
    const { team, surfaceId, projectId } = input;
    const info = this.channels.get(surfaceId);
    // Only real channels get a main repo — DMs are cross-project, and an unknown surface has no room.
    if (!info || info.kind === 'dm') return { linkedAsMain: false };
    const current = info.project;
    if (current === projectId) return { linkedAsMain: false };
    // Already pointed at a registered repo → keep it; the just-onboarded repo is a reference, not the main.
    const alreadyLinked = !!(await this.projects
      .get(team, current)
      .catch(() => undefined));
    if (alreadyLinked) return { linkedAsMain: false };

    this.channels.setProject(surfaceId, projectId);
    await this.reproject(team, current, projectId);
    this.logger.log(
      `Linked channel '${surfaceId}' to project '${projectId}' (was '${current}')`,
    );
    return { linkedAsMain: true };
  }

  /** Carry the channel's project-scoped rows from the old slug to the linked project id. Best-effort
   * per store — the link is already committed, so a failure to move one kind must not throw past it. */
  private async reproject(
    team: string,
    from: string,
    to: string,
  ): Promise<void> {
    const results = await Promise.allSettled([
      this.board.reproject(team, from, to),
      this.tasks.reproject(team, from, to),
      this.facts.reprojectFacts(team, from, to),
    ]);
    for (const r of results)
      if (r.status === 'rejected')
        this.logger.warn(`reproject ${from}→${to} partial failure: ${r.reason}`);
  }
}
