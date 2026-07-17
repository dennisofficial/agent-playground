import { createHmac } from 'node:crypto';


const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const PREVIEW_ID_LENGTH = 10;

export const MAX_EXPOSED_SERVICE_NAME_LENGTH = 52;

const EXPOSED_SERVICE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isValidExposedServiceName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_EXPOSED_SERVICE_NAME_LENGTH &&
    EXPOSED_SERVICE_NAME_RE.test(name)
  );
}

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

export function previewId(jobId: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(jobId).digest();
  return base32(digest).slice(0, PREVIEW_ID_LENGTH);
}

export function hostFor(jobId: string, name: string, secret: string, baseDomain: string): string {
  return `${previewId(jobId, secret)}-${name}.${baseDomain}`;
}

export function urlFor(jobId: string, name: string, secret: string, baseDomain: string): string {
  return `https://${hostFor(jobId, name, secret, baseDomain)}`;
}

export function routeId(jobId: string, name: string, secret: string): string {
  return `preview-${previewId(jobId, secret)}-${name}`;
}

export function routePrefix(jobId: string, secret: string): string {
  return `preview-${previewId(jobId, secret)}-`;
}
