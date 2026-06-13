import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.util';

describe('password.util', () => {
  it('hashes a password and verifies the correct plain-text', async () => {
    const plain = 'super-secret-password-123';
    const hashed = await hashPassword(plain);

    expect(hashed).not.toBe(plain);
    // Argon2id hashes start with $argon2id$
    expect(hashed).toMatch(/^\$argon2id\$/);

    const valid = await verifyPassword(plain, hashed);
    expect(valid).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hashed = await hashPassword('correct-horse-battery-staple');
    const valid = await verifyPassword('wrong-password', hashed);
    expect(valid).toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const plain = 'same-password';
    const h1 = await hashPassword(plain);
    const h2 = await hashPassword(plain);
    expect(h1).not.toBe(h2);
  });
});
