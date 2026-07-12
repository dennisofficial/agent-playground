import { describe, expect, it } from 'vitest';
import { cleanAuthHaltReason, NO_ENGINE_CREDENTIAL_MARKER } from './engine.types';

describe('cleanAuthHaltReason', () => {
  it('maps a no-credential marker message to the "connect an account" copy', () => {
    const raw = `${NO_ENGINE_CREDENTIAL_MARKER}: no claude subscription secret — the org has no claude credential set`;
    expect(cleanAuthHaltReason(raw)).toBe(
      'No Claude account is connected for this org — connect one in Settings, then resume.',
    );
  });

  it('maps a raw SDK "Not logged in" message to the generic reconnect copy and never leaks the raw text', () => {
    const clean = cleanAuthHaltReason('Not logged in · Please run /login');
    expect(clean).toBe(
      'Your Claude login needs to be reconnected — reconnect the account in Settings, then resume.',
    );
    expect(clean).not.toMatch(/not logged in|\/login/i);
  });
});
