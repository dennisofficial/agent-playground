import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ROTATE_KEYS_PRESENTER,
  type RotateKeysPresenter,
} from './rotate-keys-presenter.port';
import type { LlmProvider } from './llm-key.types';

/** One card per (team, provider) at most this often — a dead key 401s every turn; don't spam. */
const REPROMPT_WINDOW_MS = 5 * 60_000;

const LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
};

/**
 * The SYSTEM-driven half of credential rotation: when the harness's OWN key 401s on the hot path
 * (chat/gate — where Atlas's chat model IS the thing that's down, so he can't notice it himself), post
 * the update-keys card DIRECTLY (no LLM), exactly how onboarding posts the keys card when keyless.
 * Throttled per (team, provider) so a dead key — which fails every single turn — prompts once, not on
 * a loop. Degrades to a no-op when no Slack presenter is bound (headless/TUI).
 */
@Injectable()
export class CredentialHealthService {
  private readonly logger = new Logger(CredentialHealthService.name);
  private readonly lastPrompt = new Map<string, number>();

  constructor(
    @Optional()
    @Inject(ROTATE_KEYS_PRESENTER)
    private readonly presenter?: RotateKeysPresenter,
  ) {}

  /** Surface a hot-path auth failure for a workspace's own provider key as an update-keys card.
   * Fire-and-forget safe (never throws); throttled per (team, provider). */
  async reportAuthError(
    team: string,
    surfaceId: string,
    provider: LlmProvider,
  ): Promise<void> {
    if (!this.presenter) return;
    const key = `${team}:${provider}`;
    const now = Date.now();
    const last = this.lastPrompt.get(key);
    if (last !== undefined && now - last < REPROMPT_WINDOW_MS) return;
    this.lastPrompt.set(key, now);
    const label = LABEL[provider];
    await this.presenter
      .present({
        team,
        surfaceId,
        reason: `A ${label} API request was rejected (unauthorized) — the key looks expired or revoked, so the team can't run until it's updated.`,
        suspected: [`${label} API key`],
      })
      .catch((err) =>
        this.logger.warn(`rotate-keys card post failed for ${team}: ${err}`),
      );
  }
}
