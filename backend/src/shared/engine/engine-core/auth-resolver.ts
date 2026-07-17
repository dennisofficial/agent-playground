import { EngineAuthError, NO_ENGINE_CREDENTIAL_MARKER, type EngineAuth } from '../engine.types';

export class EngineAuthResolver {
  resolve(engine: 'claude' | 'codex', explicit: EngineAuth | undefined): EngineAuth {
    if (explicit) return explicit;
    throw new EngineAuthError(
      `${NO_ENGINE_CREDENTIAL_MARKER}: no ${engine} subscription secret — the org has no ${engine} ` +
        'credential set (connect one in Settings).',
      undefined,
      engine,
    );
  }
}
