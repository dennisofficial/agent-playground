import type { CodexHomeProvisioner, EngineAuth, EngineHomeKey } from '@workspace/agent-engine';
import { ensureCodexAuthHome } from './codex-auth-home';
import { getEngineAuthAdapter } from './engine-auth-adapter';

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
