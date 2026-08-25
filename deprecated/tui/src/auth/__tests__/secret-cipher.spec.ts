import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretCipherService } from '../secret-cipher.service.js';

/**
 * Every case gets its own key file. The service reads `~/.atlas/key` by default, and a test that
 * moved `HOME` would still hit the developer's real key — `domain/paths.ts` resolves the home
 * directory at module load, long before a `beforeAll` could redirect it.
 */
function cipher(): { service: SecretCipherService; keyFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-cipher-'));
  const keyFile = join(dir, '.atlas', 'key');
  return {
    service: new SecretCipherService(keyFile),
    keyFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('SecretCipherService', () => {
  it('round-trips a credential blob', () => {
    const { service, cleanup } = cipher();
    const plain = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-abc' } });
    expect(service.decrypt(service.encrypt(plain))).toBe(plain);
    cleanup();
  });

  it('never emits the same ciphertext twice — the nonce is per-call', () => {
    const { service, cleanup } = cipher();
    expect(service.encrypt('same')).not.toBe(service.encrypt('same'));
    cleanup();
  });

  it('creates the key 0600, because it decrypts every account on the machine', () => {
    const { service, keyFile, cleanup } = cipher();
    service.encrypt('x');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    cleanup();
  });

  it('re-asserts the mode on a key restored world-readable from a backup', () => {
    const { service, keyFile, cleanup } = cipher();
    service.encrypt('x');
    writeFileSync(keyFile, `${'a'.repeat(64)}\n`, { mode: 0o644 });
    new SecretCipherService(keyFile).encrypt('y');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    cleanup();
  });

  it('survives a restart — a blob outlives the instance that wrote it', () => {
    const { service, keyFile, cleanup } = cipher();
    const blob = service.encrypt('durable');
    expect(new SecretCipherService(keyFile).decrypt(blob)).toBe('durable');
    cleanup();
  });

  it('rejects a tampered ciphertext rather than returning altered plaintext', () => {
    const { service, cleanup } = cipher();
    const [iv, tag, ct] = service.encrypt('sk-ant-oat01-abc').split('.') as [string, string, string];
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => service.decrypt(`${iv}.${tag}.${flipped.toString('base64')}`)).toThrow();
    cleanup();
  });

  it('rejects a swapped auth tag — GCM is authenticated, not merely encrypted', () => {
    const { service, cleanup } = cipher();
    const [iv, , ct] = service.encrypt('one').split('.') as [string, string, string];
    const [, otherTag] = service.encrypt('two').split('.') as [string, string, string];
    expect(() => service.decrypt(`${iv}.${otherTag}.${ct}`)).toThrow();
    cleanup();
  });

  it('will not decrypt a blob written under a different key', () => {
    const a = cipher();
    const b = cipher();
    expect(() => b.service.decrypt(a.service.encrypt('secret'))).toThrow();
    a.cleanup();
    b.cleanup();
  });

  it('names the shape problem when the blob is not iv.tag.ct', () => {
    const { service, cleanup } = cipher();
    expect(() => service.decrypt('not-a-blob')).toThrow('expected iv.tag.ct');
    cleanup();
  });

  it('names the length problem when the parts are the wrong size', () => {
    const { service, cleanup } = cipher();
    const short = Buffer.from('short').toString('base64');
    expect(() => service.decrypt(`${short}.${short}.${short}`)).toThrow('bad iv/tag length');
    cleanup();
  });

  it('refuses a key file that is not 32 bytes rather than silently deriving one', () => {
    const { service, keyFile, cleanup } = cipher();
    service.encrypt('x'); // creates the directory the key lives in
    writeFileSync(keyFile, 'deadbeef\n', { mode: 0o600 });
    expect(() => new SecretCipherService(keyFile).encrypt('y')).toThrow('64 hex chars');
    cleanup();
  });
});
