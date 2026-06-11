import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantKeys } from './tenant-credential.service';

interface TurnCredentials {
  teamId: string;
  keys: TenantKeys;
}

/**
 * The per-turn tenant-key channel. In the single-process model, `process.env` can hold only ONE
 * workspace's key — so the conductor resolves the active workspace's keys and stashes them here for
 * the duration of the turn (an AsyncLocalStorage scope that follows every await). The model and
 * embedding builders read from here at call time, so gate/fetch/reconcile/the bot graph all become
 * tenant-correct with no signature changes. Outside any scope (boot, TUI dev) the getters fall back
 * to `process.env`, preserving the single-tenant dev path.
 */
@Injectable()
export class CredentialContext {
  private readonly als = new AsyncLocalStorage<TurnCredentials>();

  /** Run `fn` (and everything it awaits) with this workspace's keys in scope. */
  run<T>(creds: TurnCredentials, fn: () => T): T {
    return this.als.run(creds, fn);
  }

  /** The active workspace id, or undefined outside a turn scope. */
  teamId(): string | undefined {
    return this.als.getStore()?.teamId;
  }

  /** The Anthropic key for the active turn (store-resolved), or the process env fallback. */
  anthropicKey(): string | undefined {
    return this.als.getStore()?.keys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  }

  /** The OpenAI key for the active turn (store-resolved), or the process env fallback. */
  openaiKey(): string | undefined {
    return this.als.getStore()?.keys.openai ?? process.env.OPENAI_API_KEY;
  }
}
