import type { CodexHomeProvisioner, EngineAuth, EngineHomeKey } from '@workspace/agent-engine';
import { ensureCodexAuthHome } from './codex-auth-home';
import { getEngineAuthAdapter } from './engine-auth-adapter';

/**
 * The backend's {@link CodexHomeProvisioner} impl for {@link CodexAppServerAdapter} — wraps the existing
 * `ensureCodexAuthHome`/`getEngineAuthAdapter('codex').readBackRefresh` machinery so the adapter (and the
 * `@workspace/agent-engine` package it lives in) never needs to know about Atlas's on-disk auth-home layout.
 *
 * `bridge` is intentionally IGNORED here: `CodexAppServerAdapter` has no bridge/tool-bridge wiring in
 * thread 2 (only `writeGuard`/`richStream` capabilities), so no caller passes one yet. Constructed FRESH
 * per Codex `run()`/`runWithExtras()` call (mirroring `ClaudeAdapter`), so `writtenSecret` naturally scopes
 * to one turn.
 */
export class BackendCodexHomeProvisioner implements CodexHomeProvisioner {
  private writtenSecret?: string;

  constructor(private readonly homeRoot: string | undefined) {}

  provision(a: { sandboxKey: EngineHomeKey; auth: EngineAuth }): string {
    this.writtenSecret = a.auth.secret;
    return ensureCodexAuthHome(this.homeRoot, a.sandboxKey, a.auth.secret);
  }

  readRefreshedAuth(sandboxKey: EngineHomeKey): string | undefined {
    if (!this.writtenSecret) return undefined;
    return getEngineAuthAdapter('codex').readBackRefresh({
      homeRoot: this.homeRoot,
      key: sandboxKey,
      writtenSecret: this.writtenSecret,
    });
  }
}
