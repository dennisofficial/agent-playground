import type { WebClient } from '@slack/web-api';

const SURFACE_PREFIX = 'slack:';

/** Tenant-qualified Slack room coordinate: `slack:<teamId>:<channel>`. Slack channel ids aren't
 * guaranteed unique across workspaces, so the team id is part of the coordinate. */
const slackSurfaceId = (teamId: string, channel: string): string =>
  `${SURFACE_PREFIX}${teamId}:${channel}`;
// Re-export so callers can build surface ids without reimporting the prefix constant.
export { slackSurfaceId };

/** Parse `slack:<teamId>:<channel>` → its parts, or undefined for a non-slack / DM coordinate
 * (only real channels are posted to in v1). Used by both the chat surface and the approval-cards
 * service to route Slack-bound messages. */
export function parseSlackSurface(
  surfaceId: string,
): { teamId: string; channel: string } | undefined {
  if (!surfaceId.startsWith(SURFACE_PREFIX)) return undefined;
  const rest = surfaceId.slice(SURFACE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return undefined;
  const teamId = rest.slice(0, sep);
  const channel = rest.slice(sep + 1);
  if (!channel || channel.startsWith('dm:')) return undefined; // Slack DMs are a v2 item
  return { teamId, channel };
}

/** Narrow an unknown error to a Slack API error with one of the given codes. */
export function isSlackError(err: unknown, codes: string[]): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { data?: { error?: string } }).data?.error;
  return code !== undefined && codes.includes(code);
}

/**
 * Attempt `call()`; on a Slack membership-failure code, call `conversations.join` (public channels
 * — the `channels:join` scope) and retry ONCE. Returns `undefined` when the join/retry also fails
 * (private channel, puppet not invited) — callers fall back to another identity. Non-membership
 * errors propagate to the caller unchanged.
 *
 * `onFallback` is called when the join fails (before returning `undefined`); use it for per-class
 * dedup logging (e.g. the `membershipFallbacks` set in `SlackChatSurface`).
 */
export async function withMembershipJoin<T>(
  client: WebClient,
  channel: string,
  membershipCodes: string[],
  call: () => Promise<T>,
  onFallback?: () => void,
): Promise<T | undefined> {
  try {
    return await call();
  } catch (err) {
    if (!isSlackError(err, membershipCodes)) throw err;
    try {
      await client.conversations.join({ channel });
      return await call();
    } catch {
      onFallback?.();
      return undefined;
    }
  }
}
