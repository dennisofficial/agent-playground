import { describe, expect, it } from 'bun:test';
import { decideAdoption } from '../credential-rotation.js';

const STORED = { accessToken: 'oat-1', refreshToken: 'ort-1', expiresAt: 1_000 };

function pair(over: Partial<typeof STORED>): typeof STORED {
  return { ...STORED, ...over };
}

/**
 * The decision that stops a refresh Atlas did not perform from being lost. The engine refreshes the
 * credentials file Atlas hands it and rotates the refresh token server-side; whatever is in the file
 * afterwards is the only valid pair left, and the pair in the database is scrap.
 */
describe('decideAdoption', () => {
  it('adopts a pair the engine rotated under us', () => {
    expect(
      decideAdoption({
        observed: pair({ accessToken: 'oat-2', refreshToken: 'ort-2', expiresAt: 2_000 }),
        stored: STORED,
        others: [],
      }),
    ).toBe('adopt');
  });

  it('adopts a refreshed access token even when the refresh token is unchanged', () => {
    // Rotation of the refresh token is the server's choice, not a guarantee. A new access token on
    // the same refresh token is still a refresh, and still worth keeping.
    expect(
      decideAdoption({
        observed: pair({ accessToken: 'oat-2', expiresAt: 2_000 }),
        stored: STORED,
        others: [],
      }),
    ).toBe('adopt');
  });

  it('leaves an untouched file alone', () => {
    expect(decideAdoption({ observed: STORED, stored: STORED, others: [] })).toBe(
      'unchanged',
    );
  });

  /**
   * One engine home, several accounts: a turn on another account overwrites the same file. Writing
   * that credential onto THIS account would corrupt both rows — the wrong subscription billed, and
   * a refresh token filed under an email it does not belong to.
   */
  it('refuses a pair that belongs to another account', () => {
    expect(
      decideAdoption({
        observed: pair({ accessToken: 'oat-b', refreshToken: 'ort-b', expiresAt: 2_000 }),
        stored: STORED,
        others: [pair({ accessToken: 'oat-b', refreshToken: 'ort-b' })],
      }),
    ).toBe('foreign');
  });

  it('refuses a pair sharing only a refresh token with another account', () => {
    // The access token rotates far more often than the refresh token, so a match on either half is
    // enough to say "this file is not ours".
    expect(
      decideAdoption({
        observed: pair({ accessToken: 'oat-b2', refreshToken: 'ort-b', expiresAt: 2_000 }),
        stored: STORED,
        others: [pair({ accessToken: 'oat-b', refreshToken: 'ort-b' })],
      }),
    ).toBe('foreign');
  });

  /**
   * The file is only ever WRITTEN from the database, so it normally runs level with it or ahead. It
   * falls behind in one window: Atlas refreshes out of band (the usage poll does), and the next turn
   * dies before it gets as far as writing the file. Adopting then would put the pair Atlas already
   * replaced back over the one it replaced it with — and the older refresh token is exactly the one
   * the rotation just invalidated. A refresh only ever moves expiry forward, so that is the test.
   */
  it('refuses a pair that expires sooner than the one we hold', () => {
    expect(
      decideAdoption({
        observed: pair({ accessToken: 'oat-old', refreshToken: 'ort-old', expiresAt: 500 }),
        stored: STORED,
        others: [],
      }),
    ).toBe('stale');
  });

  it('adopts a pair with the same expiry but different tokens — a refresh inside the same second', () => {
    expect(
      decideAdoption({
        observed: pair({ accessToken: 'oat-2', refreshToken: 'ort-2' }),
        stored: STORED,
        others: [],
      }),
    ).toBe('adopt');
  });

  it('treats an empty observed pair as nothing to adopt', () => {
    // A truncated or half-written file must never overwrite a working credential with blanks.
    expect(
      decideAdoption({
        observed: pair({ accessToken: '', refreshToken: '' }),
        stored: STORED,
        others: [],
      }),
    ).toBe('unusable');
  });
});
