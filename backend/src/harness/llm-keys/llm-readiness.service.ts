import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import { LLM_PROVIDERS, PROVIDER_ENV_KEY, type LlmProvider } from './llm-key.types';
import { ProviderKeyStore } from './provider-key.store';

/** How often a pending process re-checks the store. This is the cross-process seam: keys written
 * by the api process (admin REST) become visible to the harness process within one tick. */
const PENDING_POLL_MS = 15_000;

/**
 * Pending-keys boot mode. The harness boots key-less ('pending_keys') and the conductor refuses to
 * schedule LLM turns until BOTH provider keys are available — from env (dev: env always wins) or
 * from the encrypted store (tenants: keys arrive at runtime via Jarvis/admin API). On the
 * pending→ready edge, missing keys are resolved ONCE and written into `process.env`, which is what
 * every consumer reads lazily (ChatAnthropic per call, OpenAIEmbeddings on first embed, the
 * claude/codex SDKs at session spawn) — legitimate precisely because tenant = process.
 */
@Injectable()
export class LlmReadinessService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LlmReadinessService.name);
  private state: 'pending_keys' | 'ready' = 'pending_keys';
  private timer?: NodeJS.Timeout;

  /** Fires exactly once, on the pending→ready edge. Subscribers (the conductor) re-schedule. */
  readonly ready$ = new Subject<void>();

  constructor(private readonly store: ProviderKeyStore) {}

  get isReady(): boolean {
    return this.state === 'ready';
  }

  async onModuleInit(): Promise<void> {
    const ready = await this.refresh();
    if (!ready) {
      this.logger.warn(
        'Harness is KEYLESS (pending-keys mode) — bot turns are gated until both provider keys ' +
          `land (${LLM_PROVIDERS.map((p) => PROVIDER_ENV_KEY[p]).join(', ')} via env, or the ` +
          'encrypted provider_keys store via the admin API / Jarvis). Polling every 15s.',
      );
      this.timer = setInterval(() => void this.refresh(), PENDING_POLL_MS);
      this.timer.unref?.();
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Re-evaluate key availability; returns the (possibly new) readiness. Safe to call from anywhere
   * (the pending poll, Jarvis right after a modal submission, tests). Per provider: env wins; the
   * store fills the gaps — mixed sources are fine.
   */
  async refresh(): Promise<boolean> {
    if (this.state === 'ready') return true;
    const missing = LLM_PROVIDERS.filter((p) => !process.env[PROVIDER_ENV_KEY[p]]);
    if (missing.length > 0) {
      const resolved = new Map<LlmProvider, string>();
      for (const provider of missing) {
        try {
          const key = await this.store.resolve(provider);
          if (!key) return false;
          resolved.set(provider, key);
        } catch (err) {
          // Stored rows but an unusable cipher (SECRETS_ENCRYPTION_KEY unset/wrong) — stay pending.
          this.logger.warn(`provider_keys resolve(${provider}) failed: ${err}`);
          return false;
        }
      }
      // All gaps covered — only now mutate the process env (no partial key sets).
      for (const [provider, key] of resolved) {
        process.env[PROVIDER_ENV_KEY[provider]] = key;
      }
    }
    this.state = 'ready';
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.logger.log('Provider keys are in place — engines are live.');
    this.ready$.next();
    return true;
  }
}
