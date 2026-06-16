import { ChannelRegistryService } from '@harness/channel/channel-registry.service';
import { DEFAULT_TEAM } from '@harness/domain/identity';
import { LlmReadinessService } from '@harness/llm-keys/llm-readiness.service';
import { ProviderKeyStore } from '@harness/llm-keys/provider-key.store';
import { GithubTokenStore } from '@harness/projects/github-token-store';
import {
  ProjectConflictError,
  ProjectStore,
} from '@harness/projects/project-store';
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
import { extractGithubUrl } from './github-url';
import {
  ENGINES_ONLINE,
  GREETING_PENDING,
  JARVIS_ICON_EMOJI,
  JARVIS_NAME,
  KEY_IN_CHAT_WARNING,
  KEYS_MODAL_BLOCKS,
  KEYS_MODAL_CALLBACK_ID,
  KEYS_STORED,
  NUDGE_PENDING,
  REPO_PROMPT,
  SETUP_KEYS_ACTION_ID,
  keysModalView,
  repoConflict,
  repoLinked,
  setupButtonBlocks,
} from './jarvis-blocks';

/** Something key/token-shaped pasted as chat — warn, never store, never echo. */
const KEY_IN_CHAT =
  /\b(sk-[A-Za-z0-9_-]{10,}|xox[abp]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/;

const ANTHROPIC_KEY = /^sk-ant-[\w-]{8,}$/;
const OPENAI_KEY = /^sk-[\w-]{8,}$/;
/** Permissive — classic 40-hex PATs, ghp_…, github_pat_…; just refuse whitespace/shorties. */
const GITHUB_TOKEN = /^\S{20,}$/;

/** Re-prompt suppression: identical Jarvis prompts in a channel are throttled to one per window
 * (consumed messages still get SOME response — silence would read as a swallowed message). */
const REPOST_WINDOW_MS = 60_000;

const TOKEN_NAME_ONBOARDING = 'onboarding';

/**
 * The deterministic setup concierge — the router's pre-conductor interceptor. NO LLM anywhere
 * (the tenant has no funded keys yet; scripted is better for setup anyway). Two jobs:
 *
 * 1. PENDING KEYS: consume EVERY human channel message (the conductor is hard-gated anyway, and
 *    consumed messages never enter the channel log, so nothing piles up to re-bill when keys
 *    land). Greet + offer the keys modal; warn on key-looking text.
 * 2. PROJECT-LESS CHANNELS (even when ready): consume messages until a `projects` row exists —
 *    otherwise the conductor would schedule bots whose worktree ops silently fall back to
 *    WORKER_ROOT (wrong on a tenant box). A GitHub URL message creates the project (channel-name
 *    slug = project id); anything else gets the repo prompt.
 *
 * All state is derived (readiness, registry, projects rows) except per-boot greeting/throttle
 * dedupe — a restart mid-onboarding re-greets, accepted.
 */
@Injectable()
export class JarvisService
  implements SlackInboundInterceptor, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(JarvisService.name);
  /** Channels greeted while pending — where the engines-online confirmation lands. */
  private readonly greetedPending = new Set<string>();
  /** Per-channel last prompt (key + at) — the repost throttle. */
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
  ) {}

  onModuleInit(): void {
    this.readySub = this.readiness.ready$.subscribe((teamId) => {
      void this.announceEnginesOnline(teamId);
    });
  }

  onApplicationShutdown(): void {
    this.readySub?.unsubscribe();
  }

  /** Per-(team,channel) key for the greeting/throttle sets (a Slack channel id isn't unique across
   * workspaces). */
  private k(teamId: string, channel: string): string {
    return `${teamId}|${channel}`;
  }

  /** Router contract: true = consumed, never reaches the conductor or the channel log. */
  async maybeHandle(item: SlackInbound): Promise<boolean> {
    if (item.kind === 'command') return false; // slash commands belong to the command handler
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

  /** The app invited to a channel — register the room and open the right setup conversation. */
  private async handleJoined(
    event: SlackInboundEvent,
    teamId: string,
  ): Promise<boolean> {
    if (!event.channel) return false;
    if (event.user !== (await this.directory.selfUserIdFor(teamId))) {
      // Someone other than this app joined — not Jarvis's business (single voice: no puppet bots
      // to recognise). Let it pass through.
      return false;
    }
    const channel = event.channel;
    const inviter =
      typeof event.inviter === 'string' && event.inviter
        ? (await this.directory.resolveUser(teamId, event.inviter)).authorId
        : undefined;
    await this.directory.ensureChannelRegistered(channel, teamId, inviter);

    if (!this.readiness.isReady(teamId)) {
      this.greetedPending.add(this.k(teamId, channel));
      await this.postBlocks(
        teamId,
        channel,
        setupButtonBlocks(GREETING_PENDING),
      );
    } else if (!(await this.projectOf(teamId, channel))) {
      await this.post(teamId, channel, REPO_PROMPT, 'repo-prompt');
    }
    return true; // nobody downstream handles member_joined_channel
  }

  /** Plain top-level human messages only — everything else is the surface's (non-)business. */
  private async handleMessage(
    event: SlackInboundEvent,
    teamId: string,
  ): Promise<boolean> {
    if (event.bot_id || event.subtype) return false;
    if (!event.user || !event.channel || !event.ts) return false;
    if (event.user === (await this.directory.selfUserIdFor(teamId)))
      return false;
    if (event.thread_ts && event.thread_ts !== event.ts) return false;
    const channel = event.channel;
    const text = event.text ?? '';

    const author = await this.directory.resolveUser(teamId, event.user);
    await this.directory.ensureChannelRegistered(
      channel,
      teamId,
      author.authorId,
    );

    if (!this.readiness.isReady(teamId)) {
      // Consume EVERYTHING while keyless — see the class doc.
      if (KEY_IN_CHAT.test(text)) {
        await this.post(teamId, channel, KEY_IN_CHAT_WARNING, 'key-warning');
        return true;
      }
      if (!this.greetedPending.has(this.k(teamId, channel))) {
        this.greetedPending.add(this.k(teamId, channel));
        await this.postBlocks(
          teamId,
          channel,
          setupButtonBlocks(GREETING_PENDING),
        );
      } else {
        await this.postBlocks(
          teamId,
          channel,
          setupButtonBlocks(NUDGE_PENDING),
          'nudge',
        );
      }
      return true;
    }

    // Ready: only project-less channels are Jarvis's business.
    const slug = await this.projectlessSlugOf(teamId, channel);
    if (!slug) return false;
    const gitUrl = extractGithubUrl(text);
    if (!gitUrl) {
      await this.post(teamId, channel, REPO_PROMPT, 'repo-prompt');
      return true;
    }
    return this.linkRepo(teamId, channel, slug, gitUrl);
  }

  private async linkRepo(
    teamId: string,
    channel: string,
    slug: string,
    gitUrl: string,
  ): Promise<boolean> {
    const displayName =
      this.registry
        .get(`slack:${teamId}:${channel}`)
        ?.displayName.replace(/^#/, '') ?? slug;
    try {
      await this.projects.create({
        teamId,
        projectId: slug,
        displayName,
        gitUrl,
      });
      await this.post(teamId, channel, repoLinked(gitUrl));
    } catch (err) {
      if (!(err instanceof ProjectConflictError)) throw err;
      // Raced/duplicate submission — idempotent on the same URL, explicit on a different one.
      const existing = await this.projects.get(teamId, slug);
      await this.post(
        teamId,
        channel,
        existing && existing.gitUrl !== gitUrl
          ? repoConflict(existing.gitUrl)
          : repoLinked(gitUrl),
      );
    }
    return true;
  }

  // ── Interactivity (button + modal) ───────────────────────────────────────────────────────────

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
    if (!ANTHROPIC_KEY.test(anthropic)) {
      errors[KEYS_MODAL_BLOCKS.anthropic.blockId] =
        'That does not look like an Anthropic key (sk-ant-…).';
    }
    if (!OPENAI_KEY.test(openai)) {
      errors[KEYS_MODAL_BLOCKS.openai.blockId] =
        'That does not look like an OpenAI key (sk-…).';
    }
    if (github && !GITHUB_TOKEN.test(github)) {
      errors[KEYS_MODAL_BLOCKS.github.blockId] =
        'That does not look like a GitHub token (ghp_… / github_pat_…).';
    }
    if (Object.keys(errors).length > 0) {
      await item.respond({ response_action: 'errors', errors });
      return true;
    }

    try {
      await this.providerKeys.put(teamId, 'anthropic', anthropic);
      await this.providerKeys.put(teamId, 'openai', openai);
      if (github)
        await this.githubTokens.put(
          teamId,
          TOKEN_NAME_ONBOARDING,
          github,
          true,
        );
    } catch (err) {
      // Cipher unset/misconfigured — surface it inside the modal, keys never land half-stored.
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

  private async announceEnginesOnline(teamId: string): Promise<void> {
    // ready$ fires for ONE workspace — announce only its greeted channels.
    const prefix = `${teamId}|`;
    const keys = [...this.greetedPending].filter((k) => k.startsWith(prefix));
    for (const key of keys) {
      this.greetedPending.delete(key);
      const channel = key.slice(prefix.length);
      await this.post(teamId, channel, ENGINES_ONLINE).catch((err) =>
        this.logger.warn(`engines-online post to ${channel} failed: ${err}`),
      );
    }
  }

  // ── State derivation + posting ───────────────────────────────────────────────────────────────

  private async projectOf(teamId: string, channel: string): Promise<boolean> {
    const slug = this.registry.get(`slack:${teamId}:${channel}`)?.project;
    if (!slug) return false;
    return !!(await this.projects.get(teamId, slug));
  }

  /** The channel's project slug IFF it has no projects row yet (Jarvis's ready-mode business). */
  private async projectlessSlugOf(
    teamId: string,
    channel: string,
  ): Promise<string | undefined> {
    const slug = this.registry.get(`slack:${teamId}:${channel}`)?.project;
    if (!slug) return undefined;
    return (await this.projects.get(teamId, slug)) ? undefined : slug;
  }

  /** Post as Jarvis, via the workspace's ears app. `throttleKey` suppresses identical re-prompts
   * within the repost window — consumed messages always got a response recently enough to not read
   * as swallowed. */
  private async post(
    teamId: string,
    channel: string,
    text: string,
    throttleKey?: string,
  ): Promise<void> {
    if (throttleKey && this.throttled(teamId, channel, throttleKey)) return;
    const web = await this.clients.clientFor(teamId);
    await web?.chat.postMessage({
      channel,
      text,
      username: JARVIS_NAME,
      icon_emoji: JARVIS_ICON_EMOJI,
    });
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
      username: JARVIS_NAME,
      icon_emoji: JARVIS_ICON_EMOJI,
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
