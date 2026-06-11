import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { LlmReadinessService } from '@harness/llm-keys/llm-readiness.service';
import { Injectable, Logger } from '@nestjs/common';
import { JARVIS_ICON_EMOJI, JARVIS_NAME } from './jarvis/jarvis-blocks';
import { SlackIdentityRegistry } from './slack-identity.registry';
import type { SlackInboundEvent } from './slack-inbound.types';
import { TenantSlackClients } from './tenant-slack-clients';

/** A confirmed membership is re-verified after this (the re-verify is one idempotent join/invite). */
const MEMBER_TTL_MS = 60 * 60_000;
/** Failures / missing puppet re-check after this — a freshly installed lead puppet (or newly
 * granted scope) lights up within a minute, matching the registry caches. */
const RETRY_TTL_MS = 60_000;

type PresenceState = 'member' | 'no-puppet' | 'failed';

interface PresenceEntry {
  state: PresenceState;
  expiresAt: number;
}

/** Slack WebClient errors carry the API error code at `err.data.error`. */
const slackError = (err: unknown): string =>
  String((err as { data?: { error?: string } })?.data?.error ?? err);

/**
 * Keeps the TEAM LEAD's puppet in every Slack group chat the harness serves — the lead coordinates
 * the team, so any channel where work happens needs them visible. Enforcement is an attempt-based
 * ladder, not membership polling (each rung is one idempotent call):
 *   ① public channels: the lead puppet joins itself (`conversations.join`, `channels:join` scope);
 *   ② private channels (or a failed join): the EARS app — necessarily a member, it received the
 *      event — invites the lead (`conversations.invite`, needs `groups:write`/`channels:manage`);
 *   ③ both unavailable: ONE deterministic nag (as Jarvis) asking Dennis to /invite the lead.
 * DMs are exempt by design. All state is in-memory with TTLs; a restart may re-nag once (the
 * accepted Jarvis precedent). Hooked fire-and-forget from SlackInboundRouter BEFORE the Jarvis
 * interceptor (which consumes member_joined_channel) — it must never delay or break routing.
 */
@Injectable()
export class LeadPresenceService {
  private readonly logger = new Logger(LeadPresenceService.name);
  private readonly presence = new Map<string, PresenceEntry>();
  private readonly nagged = new Set<string>();
  /** Collapses the per-message burst — concurrent calls for one channel share one attempt. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly employees: EmployeeRegistry,
    private readonly identities: SlackIdentityRegistry,
    private readonly tenants: TenantSlackClients,
    private readonly readiness: LlmReadinessService,
  ) {}

  /** Router-called for every inbound event; cheap filters first, then the presence ladder. */
  async observe(event: SlackInboundEvent, teamId: string): Promise<void> {
    try {
      if (
        event.type === 'member_joined_channel' &&
        event.user &&
        event.channel
      ) {
        // The lead arriving (by our join/invite or a manual /invite) settles the channel.
        const botId = await this.identities.botIdForSlackUser(
          teamId,
          event.user,
        );
        if (botId === this.employees.teamLead().id) {
          this.setState(teamId, event.channel, 'member');
          this.nagged.delete(this.key(teamId, event.channel));
        }
        return;
      }
      if (event.type !== 'message' || !event.channel) return;
      if (event.bot_id || event.subtype || !event.user) return; // humans drive presence, not echo
      const channelType = event.channel_type as string | undefined;
      if (channelType === 'im' || channelType === 'mpim') return; // DMs are exempt by design
      await this.ensurePresent(teamId, event.channel, channelType);
    } catch (err) {
      this.logger.warn(`presence observe failed: ${err}`);
    }
  }

  /** Make sure the lead is in the channel — join, else invite, else nag. Never throws. */
  async ensurePresent(
    teamId: string,
    channel: string,
    channelType?: string,
  ): Promise<void> {
    const key = this.key(teamId, channel);
    const cached = this.presence.get(key);
    if (cached && cached.expiresAt > Date.now()) return;
    const running = this.inFlight.get(key);
    if (running) return running;
    const attempt = this.attempt(teamId, channel, channelType).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private async attempt(
    teamId: string,
    channel: string,
    channelType?: string,
  ): Promise<void> {
    const lead = this.employees.teamLead();
    const leadUserId = await this.identities.slackUserIdFor(teamId, lead.id);
    if (!leadUserId) {
      this.setState(teamId, channel, 'no-puppet');
      await this.nag(teamId, channel, lead.name);
      return;
    }

    // ① Public channels: the lead puppet joins itself (already-in comes back ok).
    if (channelType !== 'group') {
      const puppet = await this.identities.clientFor(teamId, lead.id);
      if (puppet) {
        try {
          await puppet.conversations.join({ channel });
          this.setState(teamId, channel, 'member');
          return;
        } catch (err) {
          this.logger.debug(
            `lead join ${teamId}/${channel} failed: ${slackError(err)}`,
          );
        }
      }
    }

    // ② Private channels / failed join: the ears app (a member — it heard the event) invites.
    const ears = await this.tenants.clientFor(teamId);
    if (ears) {
      try {
        await ears.conversations.invite({ channel, users: leadUserId });
        this.setState(teamId, channel, 'member');
        return;
      } catch (err) {
        if (slackError(err) === 'already_in_channel') {
          this.setState(teamId, channel, 'member');
          return;
        }
        this.logger.warn(
          `lead invite ${teamId}/${channel} failed: ${slackError(err)}`,
        );
      }
    }

    // ③ Out of programmatic options — ask once.
    this.setState(teamId, channel, 'failed');
    await this.nag(teamId, channel, lead.name);
  }

  /** One deterministic ask per channel (per boot), posted as the Jarvis concierge identity —
   * and only in ready workspaces (during onboarding, Jarvis owns the conversation). */
  private async nag(
    teamId: string,
    channel: string,
    leadName: string,
  ): Promise<void> {
    const key = this.key(teamId, channel);
    if (this.nagged.has(key) || !this.readiness.isReady(teamId)) return;
    const ears = await this.tenants.clientFor(teamId);
    if (!ears) return;
    this.nagged.add(key);
    try {
      await ears.chat.postMessage({
        channel,
        username: JARVIS_NAME,
        icon_emoji: JARVIS_ICON_EMOJI,
        text: `Please add *${leadName}* — the team lead — to this channel (\`/invite @${leadName}\`). The team's coordination runs through ${leadName}, so they should be in every group conversation.`,
      });
    } catch (err) {
      this.nagged.delete(key); // didn't land — allowed to ask again
      this.logger.warn(
        `lead nag ${teamId}/${channel} failed: ${slackError(err)}`,
      );
    }
  }

  private key(teamId: string, channel: string): string {
    return `${teamId}|${channel}`;
  }

  private setState(teamId: string, channel: string, state: PresenceState) {
    this.presence.set(this.key(teamId, channel), {
      state,
      expiresAt:
        Date.now() + (state === 'member' ? MEMBER_TTL_MS : RETRY_TTL_MS),
    });
  }
}
