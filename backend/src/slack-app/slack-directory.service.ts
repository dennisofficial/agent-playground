import { ChannelRegistryService } from '@harness/channel/channel-registry.service';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { WebClient } from '@slack/web-api';
import { SLACK_WEB_CLIENT } from './slack.tokens';

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
 */
@Injectable()
export class SlackDirectoryService {
  private readonly logger = new Logger(SlackDirectoryService.name);
  private readonly users = new Map<string, ResolvedSlackUser>();
  private readonly registeredChannels = new Set<string>();
  private _selfUserId?: string;

  constructor(
    @Inject(SLACK_WEB_CLIENT) private readonly web: WebClient,
    private readonly registry: ChannelRegistryService,
    private readonly employees: EmployeeRegistry,
  ) {}

  /** The app's own bot user id (`auth.test`), resolved at boot by whichever transport is live.
   * Shared by the surface (echo-loop guard, self-mention translation), the router, and Jarvis. */
  get selfUserId(): string | undefined {
    return this._selfUserId;
  }

  setSelfUserId(userId: string | undefined): void {
    this._selfUserId = userId;
  }

  /** auth.test → remember our own bot user id; returns the identity for the boot banner. Called
   * by the socket transport at connect and by gateway-mode bootstrap (which never connects). */
  async resolveSelf(): Promise<{ botName: string }> {
    const auth = await this.web.auth.test();
    this._selfUserId = auth.user_id;
    return { botName: auth.user ?? 'unknown' };
  }

  /** users.info with a permanent in-memory cache (tiny team; refreshed only on process restart). */
  async resolveUser(slackUserId: string): Promise<ResolvedSlackUser> {
    const cached = this.users.get(slackUserId);
    if (cached) return cached;
    let name = slackUserId;
    try {
      const res = await this.web.users.info({ user: slackUserId });
      const profile = res.user?.profile;
      name =
        profile?.display_name || profile?.real_name || res.user?.name || slackUserId;
    } catch (err) {
      this.logger.warn(`users.info failed for ${slackUserId}: ${err}`);
    }
    const resolved: ResolvedSlackUser = {
      authorId: slugify(name),
      authorName: name,
    };
    this.users.set(slackUserId, resolved);
    return resolved;
  }

  /** Cache-only sync lookup — the resolver handed to `translateInbound` (mention ids are
   * pre-resolved async by the adapter before translating). */
  displayNameOf(slackUserId: string): string | undefined {
    return this.users.get(slackUserId)?.authorName;
  }

  /** Register `slack:<id>` as a room (project = channel-name slug, members = roster + author)
   * before the first inbound message from it reaches the conductor. No-op once known —
   * first-write-wins applies to us too, so an already-registered room (e.g. the default room from
   * the conductor's bootstrap) is left untouched. */
  async ensureChannelRegistered(
    slackChannelId: string,
    authorId?: string,
  ): Promise<void> {
    if (this.registeredChannels.has(slackChannelId)) return;
    const channelId = `slack:${slackChannelId}`;
    if (this.registry.get(channelId)) {
      this.registeredChannels.add(slackChannelId);
      return;
    }
    let name = slackChannelId;
    try {
      const res = await this.web.conversations.info({ channel: slackChannelId });
      name = res.channel?.name ?? slackChannelId;
    } catch (err) {
      this.logger.warn(`conversations.info failed for ${slackChannelId}: ${err}`);
    }
    this.registry.ensure({
      channelId,
      kind: 'channel',
      project: slugify(name),
      members: [
        ...this.employees.list().map((b) => b.id),
        ...(authorId ? [authorId] : []), // a bot self-join has no human author yet
      ],
      displayName: `#${name}`,
    });
    this.registeredChannels.add(slackChannelId);
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
