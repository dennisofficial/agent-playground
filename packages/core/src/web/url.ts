const MAX_URL_LENGTH = 2048

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]'])

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

export enum EUrlRefusal {
  Malformed = 'malformed',
  TooLong = 'too-long',
  UnsupportedScheme = 'unsupported-scheme',
  PrivateHost = 'private-host',
}

export type AcceptedUrl = { ok: true; url: string; host: string }

export type RefusedUrl = { ok: false; refusal: EUrlRefusal; reason: string }

export type UrlVerdict = AcceptedUrl | RefusedUrl

const bracketless = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

export function isPrivateHost(host: string): boolean {
  const bare = bracketless(host.toLowerCase())
  if (LOOPBACK.has(bare) || LOOPBACK.has(host.toLowerCase())) return true
  if (bare.endsWith('.localhost') || bare.endsWith('.internal') || bare.endsWith('.local'))
    return true
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true
  return PRIVATE_V4.some((pattern) => pattern.test(bare))
}

/**
 * A URL is upgraded to https and refused before a socket opens rather than after, so a page can
 * never talk the harness into reaching something on the developer's own network.
 */
export function acceptUrl(candidate: string): UrlVerdict {
  const trimmed = candidate.trim()
  if (trimmed.length === 0)
    return { ok: false, refusal: EUrlRefusal.Malformed, reason: 'the url is empty' }
  if (trimmed.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      refusal: EUrlRefusal.TooLong,
      reason: `the url is ${trimmed.length} characters, above the ${MAX_URL_LENGTH} allowed`,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, refusal: EUrlRefusal.Malformed, reason: `"${trimmed}" is not a url` }
  }

  if (parsed.protocol === 'http:') parsed.protocol = 'https:'
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      refusal: EUrlRefusal.UnsupportedScheme,
      reason: `${parsed.protocol.replace(':', '')} urls cannot be fetched; only http and https can`,
    }
  }

  if (isPrivateHost(parsed.hostname)) {
    return {
      ok: false,
      refusal: EUrlRefusal.PrivateHost,
      reason: `${parsed.hostname} is on a private or loopback network, which the web tools never reach`,
    }
  }

  return { ok: true, url: parsed.toString(), host: parsed.hostname }
}

export const sameHost = (left: string, right: string): boolean => {
  try {
    return new URL(left).hostname === new URL(right).hostname
  } catch {
    return false
  }
}
