import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, loadSecretsKey } from './secret-cipher';

const KEY_HEX = '00'.repeat(32); // 64 hex chars → 32 bytes
const KEY_B64 = Buffer.alloc(32, 7).toString('base64'); // 32 bytes base64

describe('secret-cipher', () => {
  describe('loadSecretsKey', () => {
    it('decodes 64-hex-char keys to 32 bytes', () => {
      expect(loadSecretsKey(KEY_HEX)).toHaveLength(32);
    });

    it('decodes base64 keys to 32 bytes', () => {
      expect(loadSecretsKey(KEY_B64)).toHaveLength(32);
    });

    it('refuses loudly when unset', () => {
      expect(() => loadSecretsKey(undefined)).toThrow(
        /SECRETS_ENCRYPTION_KEY is not set/,
      );
    });

    it('refuses a wrong-length key', () => {
      expect(() => loadSecretsKey(Buffer.alloc(16).toString('base64'))).toThrow(
        /32 bytes/,
      );
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    const key = loadSecretsKey(KEY_B64);

    it('round-trips a secret', () => {
      const plain = 'sk-ant-super-secret-value-123';
      const blob = encryptSecret(plain, key);
      expect(blob).not.toContain(plain); // ciphertext, not plaintext
      expect(blob.split('.')).toHaveLength(3); // iv.tag.ct
      expect(decryptSecret(blob, key)).toBe(plain);
    });

    it('uses a fresh IV per call (same plaintext → different ciphertext)', () => {
      expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
    });

    it('fails to decrypt under a different key (auth tag mismatch)', () => {
      const blob = encryptSecret('x', key);
      const other = loadSecretsKey(KEY_HEX);
      expect(() => decryptSecret(blob, other)).toThrow();
    });

    it('fails to decrypt a tampered blob', () => {
      const blob = encryptSecret('hello', key);
      const [iv, tag, ct] = blob.split('.');
      const tamperedCt = Buffer.from(ct, 'base64');
      tamperedCt[0] ^= 0xff;
      expect(() =>
        decryptSecret(`${iv}.${tag}.${tamperedCt.toString('base64')}`, key),
      ).toThrow();
    });

    it('rejects a malformed blob', () => {
      expect(() => decryptSecret('not-a-valid-blob', key)).toThrow(/Malformed/);
    });
  });
});
