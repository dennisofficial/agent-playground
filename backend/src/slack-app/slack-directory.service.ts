import { ChannelRegistryService } from '@harness/channel/channel-registry.service';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { Injectable, Logger } from '@nestjs/common';
import { TenantSlackClients } from './tenant-slack-clients';

export interface ResolvedSlackUser {
  /** Harness author id — lowercased display-name slug, so the bootstrap `'dennis'` member id and
   * pair-scope memory coordinates (`pair:alex:dennis`) keep working. */
  authorId: string;
  authorName: string;
}

/**
 * Slack workspace directory: users.info / conversations.info lookups behind in-memory caches, plus
 * the room-registration step that MUST precede emitting an inbound message. `ChannelRegistryService.
 * ensure` is first-write-wins — if `submitFrom`'s lazy ensure ran first the room would freeze at
 * the default project with no display name, so the adapter registers Slack rooms itself with the
 * channel-name slug as `project` and the FULL roster as members (the scheduler only runs bots
 * listed in a room's members — omitting them is a silently dead room).
 *
 * Everything is PER WORKSPACE: the OAuth-distributed ears app has a different bot token + bot user
 * id per install, and Slack user/channel ids aren't globally unique — so every method takes a
 * `teamId`, the caches key by `(teamId, id)`, and the Slack client comes from TenantSlackClients.
 */
@Injectable()
export class SlackDirectoryService {
  private readonly logger = new Logger(SlackDirectoryService.name);
  private readonly users = new Map<string, ResolvedSlackUser>();
  private readonly registeredChannels = new Set<string>();

  constructor(
    private readonly clients: TenantSlackClients,
    private readonly registry: ChannelRegistryService,
    private readonly employees: EmployeeRegistry,
  ) {}

  /** This app's bot user id IN a workspace (echo-loop guard + self-mention translation). */
  selfUserIdFor(teamId: string): Promise<string | undefined> {
    return this.clients.selfUserIdFor(teamId);
  }

  /** Boot-banner identity (dev env token); empty in prod. */
  bootIdentity(): Promise<{ botName?: string }> {
    return this.clients.bootIdentity();
  }

  /** users.info (in the workspace's token) with a per-(team,user) cache. */
  async resolveUser(
    teamId: string,
    slackUserId: string,
  ): Promise<ResolvedSlackUser> {
    const cached = this.users.get(`${teamId}|${slackUserId}`);
    if (cached) return cached;
    let name = slackUserId;
    try {
      const web = await this.clients.clientFor(teamId);
      const res = await web?.users.info({ user: slackUserId });
      const profile = res?.user?.profile;
      name =
        profile?.display_name || profile?.real_name || res?.user?.name || slackUserId;
    } catch (err) {
      this.logger.warn(`users.info failed for ${teamId}/${slackUserId}: ${err}`);
    }
    const resolved: ResolvedSlackUser = {
      authorId: slugify(name),
      authorName: name,
    };
    this.users.set(`${teamId}|${slackUserId}`, resolved);
    return resolved;
  }

  /** Cache-only sync lookup — the resolver handed to `translateInbound` (mention ids are
   * pre-resolved async by the adapter before translating). */
  displayNameOf(teamId: string, slackUserId: string): string | undefined {
    return this.users.get(`${teamId}|${slackUserId}`)?.authorName;
  }

  /** Register `slack:<teamId>:<id>` as a room (project = channel-name slug, members = roster +
   * author) before the first inbound message from it reaches the conductor. No-op once known —
   * first-write-wins applies to us too, so an already-registered room (e.g. the default room from
   * the conductor's bootstrap) is left untouched. */
  async ensureChannelRegistered(
    slackChannelId: string,
    teamId: string,
    authorId?: string,
  ): Promise<void> {
    // Slack channel ids are unique within a workspace but not guaranteed across workspaces, so the
    // dedup key (and the registered coordinate) are tenant-qualified.
    const key = `${teamId}:${slackChannelId}`;
    if (this.registeredChannels.has(key)) return;
    const channelId = `slack:${teamId}:${slackChannelId}`;
    if (this.registry.get(channelId)) {
      this.registeredChannels.add(key);
      return;
    }
    let name = slackChannelId;
    try {
      const web = await this.clients.clientFor(teamId);
      const res = await web?.conversations.info({ channel: slackChannelId });
      name = res?.channel?.name ?? slackChannelId;
    } catch (err) {
      this.logger.warn(`conversations.info failed for ${teamId}/${slackChannelId}: ${err}`);
    }
    this.registry.ensure({
      channelId,
      teamId,
      kind: 'channel',
      project: slugify(name),
      members: [
        ...this.employees.list().map((b) => b.id),
        ...(authorId ? [authorId] : []), // a bot self-join has no human author yet
      ],
      displayName: `#${name}`,
    });
    this.registeredChannels.add(key);
  }
}

/** Lowercased project/author slug (Slack channel names are already lowercase kebab; display names
 * are not). Matches the registered `project_id` charset (`[a-z0-9._-]`). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}
