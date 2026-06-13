import { hash, verify } from '@node-rs/argon2';

/** Argon2id defaults from @node-rs/argon2 are strong enough for production use. */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(
  plain: string,
  hashed: string,
): Promise<boolean> {
  return verify(hashed, plain);
}
