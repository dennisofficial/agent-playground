import { createHmac } from 'node:crypto';

/**
 * Deterministic sandbox-preview naming — PURE functions, zero Nest/DI deps (the service resolves the
 * `secret`/`baseDomain` from env and passes them in). Everything a preview URL needs is derived from the
 * `jobId` + a server-side `secret` via HMAC, so a preview host is stable, unguessable, and needs no
 * storage: the same `jobId` always yields the same `previewId`, and nobody can enumerate live previews
 * without the secret.
 */

/** RFC 4648 base32 alphabet, lowercased — url/host-safe (no padding, no case ambiguity). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Length of the public preview token. 50 bits of HMAC output — ample against guessing, short in a host. */
const PREVIEW_ID_LENGTH = 10;

/**
 * Max service-name length for `<previewId>-<service>.<domain>`: DNS labels cap at 63 octets, and the
 * preview prefix contributes 11 chars (`10 token + "-"`). Exposed service names must also avoid
 * underscores and trailing hyphens so the generated URL is a real browser/DNS hostname.
 */
export const MAX_EXPOSED_SERVICE_NAME_LENGTH = 52;

const EXPOSED_SERVICE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Whether an `atlas-svc --name` can safely become the service part of a public preview hostname. */
export function isValidExposedServiceName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_EXPOSED_SERVICE_NAME_LENGTH &&
    EXPOSED_SERVICE_NAME_RE.test(name)
  );
}

/** Encode bytes as RFC 4648 base32 (no padding) using the lowercased alphabet. */
function base32(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * The stable, unguessable public token for a job — `base32(hmac_sha256(secret, jobId))` sliced to
 * {@link PREVIEW_ID_LENGTH}. Deterministic (no storage) yet unenumerable without the secret.
 */
export function previewId(jobId: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(jobId).digest();
  return base32(digest).slice(0, PREVIEW_ID_LENGTH);
}

/** The public preview host for a named dev service — `<previewId>-<name>.<baseDomain>`. */
export function hostFor(
  jobId: string,
  name: string,
  secret: string,
  baseDomain: string,
): string {
  return `${previewId(jobId, secret)}-${name}.${baseDomain}`;
}

/** The public preview URL for a named dev service — always https (Caddy terminates TLS). */
export function urlFor(
  jobId: string,
  name: string,
  secret: string,
  baseDomain: string,
): string {
  return `https://${hostFor(jobId, name, secret, baseDomain)}`;
}

/** The Caddy route `@id` for a named dev service — `preview-<previewId>-<name>`. */
export function routeId(jobId: string, name: string, secret: string): string {
  return `preview-${previewId(jobId, secret)}-${name}`;
}

/** The common `@id` prefix of ALL of a job's Caddy routes — used to reconcile/delete a job's routes. */
export function routePrefix(jobId: string, secret: string): string {
  return `preview-${previewId(jobId, secret)}-`;
}
