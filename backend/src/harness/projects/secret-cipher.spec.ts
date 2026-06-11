import type { EnvService } from '@core/config/env/env.service';
import { randomBytes } from 'node:crypto';
import { SecretCipher } from './secret-cipher';

const withKey = (key: string | undefined) =>
  new SecretCipher({
    get: (k: string) => (k === 'SECRETS_ENCRYPTION_KEY' ? key : undefined),
  } as unknown as EnvService);

describe('SecretCipher', () => {
  it('roundtrips with a base64 key and a hex key', () => {
    for (const key of [
      randomBytes(32).toString('base64'),
      randomBytes(32).toString('hex'),
    ]) {
      const cipher = withKey(key);
      const ct = cipher.encrypt('ghp_secret_token');
      expect(ct.startsWith('v1:')).toBe(true);
      expect(ct).not.toContain('ghp_secret_token');
      expect(cipher.decrypt(ct)).toBe('ghp_secret_token');
    }
  });

  it('produces distinct ciphertexts per call (random IV)', () => {
    const cipher = withKey(randomBytes(32).toString('base64'));
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('throws on tampered ciphertext (auth tag)', () => {
    const cipher = withKey(randomBytes(32).toString('base64'));
    const ct = cipher.encrypt('secret');
    const parts = ct.split(':');
    const ctBuf = Buffer.from(parts[3], 'base64');
    ctBuf[0] ^= 0xff;
    parts[3] = ctBuf.toString('base64');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow();
  });

  it('refuses with actionable errors when the key is unset or the wrong size', () => {
    expect(withKey(undefined).isConfigured()).toBe(false);
    expect(() => withKey(undefined).encrypt('x')).toThrow(
      /SECRETS_ENCRYPTION_KEY is not set/,
    );
    expect(() =>
      withKey(randomBytes(16).toString('base64')).encrypt('x'),
    ).toThrow(/exactly 32 bytes/);
  });

  it('rejects unrecognized ciphertext formats', () => {
    const cipher = withKey(randomBytes(32).toString('base64'));
    expect(() => cipher.decrypt('not-a-ciphertext')).toThrow(
      /Unrecognized ciphertext/,
    );
  });
});
