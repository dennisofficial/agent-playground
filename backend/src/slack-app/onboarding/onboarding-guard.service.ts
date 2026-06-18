import { ChannelRegistryService } from '@harness/channel/channel-registry.service';
import { channelWelcomeSeed } from '@harness/conductor/seed-relay';
import { ConductorService } from '@harness/conductor/conductor.service';
import { DEFAULT_TEAM } from '@harness/domain/identity';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { LlmReadinessService } from '@harness/llm-keys/llm-readiness.service';
import { ProviderKeyStore } from '@harness/llm-keys/provider-key.store';
import { GithubTokenStore } from '@harness/projects/github-token-store';
import { ProjectStore } from '@harness/projects/project-store';
import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { SlackDirectoryService } from '../slack-directory.service';
import { TenantSlackClients } from '../tenant-slack-clients';
import type {
  SlackInbound,
  SlackInboundEvent,
  SlackInboundInterceptor,
  SlackInteractivityPayload,
} from '../slack-inbound.types';
import {
  KEY_IN_CHAT_WARNING,
  KEYS_MODAL_BLOCKS,
  KEYS_MODAL_CALLBACK_ID,
  KEYS_PROMPT,
  KEYS_STORED,
  SETUP_KEYS_ACTION_ID,
  keysModalView,
  setupButtonBlocks,
} from './onboarding-guard-blocks';

/** Something key/token-shaped pasted as chat — warn, never store, never echo. */
const KEY_IN_CHAT =
  /\b(sk-[A-Za-z0-9_-]{10,}|xox[abp]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/;

const ANTHROPIC_KEY = /^sk-ant-[\w-]{8,}$/;
const OPENAI_KEY = /^sk-[\w-]{8,}$/;
/** Permissive — classic 40-hex PATs, ghp_…, github_pat_…; just refuse whitespace/shorties. */
const GITHUB_TOKEN = /^\S{20,}$/;

/** Re-prompt suppression: the keys prompt in a channel is throttled to one per window. */
const REPOST_WINDOW_MS = 60_000;

const TOKEN_NAME_ONBOARDING = 'onboarding';

/**
 * The deterministic, VOICELESS keyless guard — the router's pre-conductor interceptor, all that
 * survives of the old "Jarvis" concierge. NO LLM (the workspace has no funded keys yet, and running
 * Atlas requires the very keys this collects — so key entry can't be an Atlas turn). Two jobs:
 *
 * 1. KEYLESS GATE: while a workspace has no funded keys, consume EVERY human channel message (the
 *    conductor is hard-gated anyway, and consumed messages never enter the channel log, so nothing
 *    piles up to re-bill when keys land). Surface the keys modal (the only non-admin key entry path)
 *    and warn on key-shaped chat.
 * 2. JOIN HAND-OFF: when the app is added to a channel, register the room; if keyless, prompt for
 *    keys; if READY, hand the welcome to ATLAS via a gate-bypassed seed (Atlas greets + offers to
 *    onboard a repo — see channelWelcomeSeed). Once keys land, greeted channels get the same Atlas
 *    welcome instead of a scripted "online" line.
 *
 * Everything conversational (greeting, linking a repo, references) is Atlas's now; this is just the
 * circuit-breaker. Project-less channels are NOT consumed here — Atlas drives that onboarding, and
 * the dispatch tools guard against an unlinked repo.
 */
@Injectable()
export class OnboardingGuardService
  implements SlackInboundInterceptor, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(OnboardingGuardService.name);
  /** Channels prompted while pending — where the Atlas welcome lands once keys arrive. */
  private readonly greetedPending = new Set<string>();
  private readonly lastPrompt = new Map<string, { key: string; at: number }>();
  private readySub?: Subscription;

  constructor(
    private readonly clients: TenantSlackClients,
    private readonly directory: SlackDirectoryService,
    private readonly registry: ChannelRegistryService,
    private readonly readiness: LlmReadinessService,
    private readonly providerKeys: ProviderKeyStore,
    private readonly githubTokens: GithubTokenStore,
    private readonly projects: ProjectStore,
    private readonly conductor: ConductorService,
    private readonly employees: EmployeeRegistry,
  ) {}

  onModuleInit(): void {
    this.readySub = this.readiness.ready$.subscribe((teamId) => {
      void this.greetReadyChannels(teamId);
    });
  }

  onApplicationShutdown(): void {
    this.readySub?.unsubscribe();
  }

  private k(teamId: string, channel: string): string {
    return `${teamId}|${channel}`;
  }

  /** Router contract: true = consumed, never reaches the conductor or the channel log. */
  async maybeHandle(item: SlackInbound): Promise<boolean> {
    if (item.kind === 'command') return false;
    if (item.kind === 'interactivity') {
      const teamId = item.payload.team?.id ?? DEFAULT_TEAM;
      return this.handleInteractivity(item, teamId);
    }
    const event = item.body.event;
    if (!event) return false;
    const teamId = item.body.team_id ?? DEFAULT_TEAM;
    if (event.type === 'member_joined_channel')
      return this.handleJoined(event, teamId);
    if (event.type === 'message') return this.handleMessage(event, teamId);
    return false;
  }

  // ── Channel events ───────────────────────────────────────────────────────────────────────────

  /** The app invited to a channel — register the room, then prompt for keys (keyless) or hand the
   * welcome to Atlas (ready). */
  private async handleJoined(
    event: SlackInboundEvent,
    teamId: string,
  ): Promise<boolean> {
    if (!event.channel) return false;
    if (event.user !== (await this.directory.selfUserIdFor(teamId)))
      return false; // someone else joined — not our concern
    const channel = event.channel;
    const inviter =
      typeof event.inviter === 'string' && event.inviter
        ? (await this.directory.resolveUser(teamId, event.inviter)).authorId
        : undefined;
    await this.directory.ensureChannelRegistered(channel, teamId, inviter);

    if (!this.readiness.isReady(teamId)) {
      this.greetedPending.add(this.k(teamId, channel));
      await this.postBlocks(teamId, channel, setupButtonBlocks(KEYS_PROMPT));
    } else {
      await this.seedWelcome(teamId, channel);
    }
    return true; // nobody downstream handles member_joined_channel
  }

  /** Keyless guard ONLY — consume human messages while the workspace has no keys. Once ready, this
   * returns false so the message flows to the conductor (Atlas), which owns all conversation. */
  private async handleMessage(
    event: SlackInboundEvent,
    teamId: string,
  ): Promise<boolean> {
    if (event.bot_id || event.subtype) return false;
    if (!event.user || !event.channel || !event.ts) return false;
    if (event.user === (await this.directory.selfUserIdFor(teamId)))
      return false;
    if (event.thread_ts && event.thread_ts !== event.ts) return false;
    if (this.readiness.isReady(teamId)) return false; // ready → Atlas's turn, not ours

    const channel = event.channel;
    const text = event.text ?? '';
    const author = await this.directory.resolveUser(teamId, event.user);
    await this.directory.ensureChannelRegistered(
      channel,
      teamId,
      author.authorId,
    );

    if (KEY_IN_CHAT.test(text)) {
      await this.post(teamId, channel, KEY_IN_CHAT_WARNING, 'key-warning');
      return true;
    }
    this.greetedPending.add(this.k(teamId, channel));
    await this.postBlocks(
      teamId,
      channel,
      setupButtonBlocks(KEYS_PROMPT),
      'keys-prompt',
    );
    return true;
  }

  // ── Interactivity (keys modal) ─────────────────────────────────────────────────────────────────

  private async handleInteractivity(
    item: Extract<SlackInbound, { kind: 'interactivity' }>,
    teamId: string,
  ): Promise<boolean> {
    const payload = item.payload;
    if (
      payload.type === 'block_actions' &&
      payload.actions?.some((a) => a.action_id === SETUP_KEYS_ACTION_ID)
    ) {
      await item.respond();
      const originChannel = payload.channel?.id ?? '';
      const hasGithubToken =
        (await this.githubTokens.listMeta(teamId)).length > 0;
      const web = await this.clients.clientFor(teamId);
      await web?.views.open({
        trigger_id: payload.trigger_id ?? '',
        view: keysModalView(originChannel, hasGithubToken) as never,
      });
      return true;
    }
    if (
      payload.type === 'view_submission' &&
      payload.view?.callback_id === KEYS_MODAL_CALLBACK_ID
    ) {
      return this.handleKeysSubmission(item, payload, teamId);
    }
    return false;
  }

  private async handleKeysSubmission(
    item: Extract<SlackInbound, { kind: 'interactivity' }>,
    payload: SlackInteractivityPayload,
    teamId: string,
  ): Promise<boolean> {
    const values = payload.view?.state?.values ?? {};
    const input = (coord: { blockId: string; actionId: string }): string =>
      (values[coord.blockId]?.[coord.actionId]?.value ?? '').trim();
    const anthropic = input(KEYS_MODAL_BLOCKS.anthropic);
    const openai = input(KEYS_MODAL_BLOCKS.openai);
    const github = input(KEYS_MODAL_BLOCKS.github);

    const errors: Record<string, string> = {};
    if (!ANTHROPIC_KEY.test(anthropic))
      errors[KEYS_MODAL_BLOCKS.anthropic.blockId] =
        'That does not look like an Anthropic key (sk-ant-…).';
    if (!OPENAI_KEY.test(openai))
      errors[KEYS_MODAL_BLOCKS.openai.blockId] =
        'That does not look like an OpenAI key (sk-…).';
    if (github && !GITHUB_TOKEN.test(github))
      errors[KEYS_MODAL_BLOCKS.github.blockId] =
        'That does not look like a GitHub token (ghp_… / github_pat_…).';
    if (Object.keys(errors).length > 0) {
      await item.respond({ response_action: 'errors', errors });
      return true;
    }

    try {
      await this.providerKeys.put(teamId, 'anthropic', anthropic);
      await this.providerKeys.put(teamId, 'openai', openai);
      if (github)
        await this.githubTokens.put(teamId, TOKEN_NAME_ONBOARDING, github, true);
    } catch (err) {
      this.logger.error(`key storage failed: ${err}`);
      await item.respond({
        response_action: 'errors',
        errors: {
          [KEYS_MODAL_BLOCKS.anthropic.blockId]:
            'Storing failed on the server (encryption key missing?) — check the stack logs.',
        },
      });
      return true;
    }

    await item.respond(); // clear the modal
    const wasPending = !this.readiness.isReady(teamId);
    await this.readiness.refresh(teamId);
    const origin = payload.view?.private_metadata;
    if (origin && wasPending) await this.post(teamId, origin, KEYS_STORED);
    return true;
  }

  /** ready$ fires for ONE workspace — hand the Atlas welcome to each channel greeted while pending. */
  private async greetReadyChannels(teamId: string): Promise<void> {
    const prefix = `${teamId}|`;
    const keys = [...this.greetedPending].filter((k) => k.startsWith(prefix));
    for (const key of keys) {
      this.greetedPending.delete(key);
      const channel = key.slice(prefix.length);
      await this.seedWelcome(teamId, channel).catch((err) =>
        this.logger.warn(`welcome seed for ${channel} failed: ${err}`),
      );
    }
  }

  /** Hand the new-channel welcome to Atlas (gate-bypassed seed) — he greets in his own voice. */
  private async seedWelcome(teamId: string, channel: string): Promise<void> {
    const info = this.registry.get(`slack:${teamId}:${channel}`);
    const project = info?.project ?? '';
    const hasProject = project
      ? !!(await this.projects.get(teamId, project).catch(() => undefined))
      : false;
    const atlas = this.employees.teamLead();
    this.conductor.injectSeed(
      atlas.id,
      `slack:${teamId}:${channel}`,
      channelWelcomeSeed({
        displayName: info?.displayName ?? channel,
        project,
        hasProject,
      }),
    );
  }

  // ── Posting (voiceless — the workspace app's own identity, no character override) ───────────────

  private async post(
    teamId: string,
    channel: string,
    text: string,
    throttleKey?: string,
  ): Promise<void> {
    if (throttleKey && this.throttled(teamId, channel, throttleKey)) return;
    const web = await this.clients.clientFor(teamId);
    await web?.chat.postMessage({ channel, text });
  }

  private async postBlocks(
    teamId: string,
    channel: string,
    msg: { text: string; blocks: unknown[] },
    throttleKey?: string,
  ): Promise<void> {
    if (throttleKey && this.throttled(teamId, channel, throttleKey)) return;
    const web = await this.clients.clientFor(teamId);
    await web?.chat.postMessage({
      channel,
      text: msg.text,
      blocks: msg.blocks as never,
    });
  }

  private throttled(teamId: string, channel: string, key: string): boolean {
    const k = `${teamId}|${channel}`;
    const last = this.lastPrompt.get(k);
    const now = Date.now();
    if (last && last.key === key && now - last.at < REPOST_WINDOW_MS)
      return true;
    this.lastPrompt.set(k, { key, at: now });
    return false;
  }
}
