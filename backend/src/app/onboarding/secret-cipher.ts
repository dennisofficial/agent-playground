import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The ONE secret-at-rest primitive for Atlas v2's onboarding layer — AES-256-GCM, reused by every
 * encrypted store (tenant credentials + Slack installations). Clean-room (v1's encrypted-token helper
 * was dropped with the rest of v1); same posture the env doc promised: a key MUST be present to encrypt
 * or decrypt, otherwise we refuse loudly. The key is read lazily by callers (never at module
 * construction) so a key-less single-tenant dev box still boots — it just has no encrypted rows to read.
 *
 * Blob format: `base64(iv).base64(authTag).base64(ciphertext)` — a single, self-describing decrypt path.
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit nonce, the GCM standard
const TAG_LEN = 16;

/**
 * Decode `SECRETS_ENCRYPTION_KEY` (64 hex chars OR base64) into a 32-byte key. Throws actionably when
 * unset or the wrong length — onboarding secret WRITES must fail loudly without a key (reads of a
 * key-less, row-less dev box never reach here).
 */
export function loadSecretsKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY is not set — refusing to read or write encrypted tenant credentials.',
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}) — use 64 hex chars or 32-byte base64.`,
    );
  }
  return key;
}

/** Encrypt a UTF-8 secret → `iv.tag.ct` (all base64). A fresh random IV per call. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

/** Decrypt an `iv.tag.ct` blob produced by {@link encryptSecret}. Throws on tamper / malformed input. */
export function decryptSecret(blob: string, key: Buffer): string {
  const parts = blob.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret blob (expected iv.tag.ct).');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Malformed encrypted secret blob (bad iv/tag length).');
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    'utf8',
  );
}
