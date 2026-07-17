import { describe, expect, it } from 'vitest';
import { EngineAuthError, NO_ENGINE_CREDENTIAL_MARKER } from '../engine.types';
import { EngineAuthResolver } from './auth-resolver';

describe('EngineAuthResolver.resolve', () => {
  it('returns the explicit auth when given', () => {
    const resolver = new EngineAuthResolver();
    const explicit = { secret: 'shh' } as never;
    expect(resolver.resolve('claude', explicit)).toBe(explicit);
  });

  it('throws an EngineAuthError with the no-credential marker for claude when explicit is undefined', () => {
    const resolver = new EngineAuthResolver();
    expect(() => resolver.resolve('claude', undefined)).toThrow(EngineAuthError);
    expect(() => resolver.resolve('claude', undefined)).toThrow(
      new RegExp(NO_ENGINE_CREDENTIAL_MARKER),
    );
  });

  it('throws an EngineAuthError with the no-credential marker for codex when explicit is undefined', () => {
    const resolver = new EngineAuthResolver();
    expect(() => resolver.resolve('codex', undefined)).toThrow(EngineAuthError);
    expect(() => resolver.resolve('codex', undefined)).toThrow(
      new RegExp(NO_ENGINE_CREDENTIAL_MARKER),
    );
  });
});
