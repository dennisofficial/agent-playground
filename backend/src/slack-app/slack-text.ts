/**
 * Pure Slack ⇄ harness text translation. Inbound: Slack's mrkdwn encoding (`<@U…>` mentions,
 * `<!here>` specials, `<url|label>` links, HTML entities) → the plain text the gate/addressing
 * rules expect (bare names, `@here`). No Slack client here — `resolveUser` is injected so this
 * stays unit-testable.
 */

export interface InboundTranslationDeps {
  /** Slack user id → display name (undefined when unknown — the raw id is kept then). */
  resolveUser: (slackUserId: string) => string | undefined;
  /** Our own bot's Slack user id — mentioning the app hails the whole roster (`@here`). */
  selfBotUserId?: string;
}

/** The Slack user ids mentioned in a raw mrkdwn text — pre-resolve these (async users.info)
 * before calling the sync `translateInbound`. */
export function extractMentionIds(text: string): string[] {
  return [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
}

/** Slack mrkdwn → plain harness text. Order matters: structured `<…>` tokens first, then entity
 * unescape (Slack escapes literal `< > &` as entities — unescaping first would corrupt tokens). */
export function translateInbound(
  text: string,
  deps: InboundTranslationDeps,
): string {
  let out = text;

  // User mentions: <@U123>, <@W123>, <@U123|label>
  out = out.replace(
    /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g,
    (_m, id: string, label?: string) => {
      if (deps.selfBotUserId && id === deps.selfBotUserId) return '@here';
      return deps.resolveUser(id) ?? label ?? id;
    },
  );

  // Special mentions: <!here>, <!channel>, <!everyone> (optionally with |label)
  out = out.replace(
    /<!(here|channel|everyone)(?:\|[^>]*)?>/g,
    (_m, kind: string) => (kind === 'channel' ? '@channel' : `@${kind}`),
  );

  // Links: <url|label> → "label (url)", <url> → url. Skip other <!…>/<#…> tokens' internals —
  // channel refs <#C042|dev> become their label.
  out = out.replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_m, label: string) =>
    label ? `#${label}` : '',
  );
  out = out.replace(
    /<((?:https?|mailto):[^|>]*)\|([^>]*)>/g,
    (_m, url: string, label: string) => (label ? `${label} (${url})` : url),
  );
  out = out.replace(/<((?:https?|mailto):[^|>]*)>/g, '$1');

  // HTML entities last.
  out = out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  return out;
}

/** Unicode emoji → Slack shortcode names for `reactions.add` (the gate/ack path emits unicode,
 * e.g. '👍'). Already-bare shortcode strings pass through; unknown emoji fall back to thumbsup. */
const EMOJI_TO_SLACK: Record<string, string> = {
  '👍': 'thumbsup',
  '👎': 'thumbsdown',
  '✅': 'white_check_mark',
  '☑️': 'ballot_box_with_check',
  '✔️': 'heavy_check_mark',
  '👀': 'eyes',
  '🎉': 'tada',
  '🎊': 'confetti_ball',
  '❤️': 'heart',
  '🙏': 'pray',
  '🚀': 'rocket',
  '🔥': 'fire',
  '😂': 'joy',
  '😄': 'smile',
  '😊': 'blush',
  '🙂': 'slightly_smiling_face',
  '😅': 'sweat_smile',
  '🤔': 'thinking_face',
  '😮': 'open_mouth',
  '😢': 'cry',
  '😭': 'sob',
  '💪': 'muscle',
  '👏': 'clap',
  '🙌': 'raised_hands',
  '👌': 'ok_hand',
  '🤝': 'handshake',
  '💯': '100',
  '⭐': 'star',
  '🌟': 'star2',
  '⚡': 'zap',
  '💡': 'bulb',
  '📝': 'memo',
  '📌': 'pushpin',
  '🔍': 'mag',
  '🐛': 'bug',
  '⚠️': 'warning',
  '❌': 'x',
  '❓': 'question',
  '⏳': 'hourglass_flowing_sand',
  '⏰': 'alarm_clock',
  '🕐': 'clock1',
  '🛠️': 'hammer_and_wrench',
  '🔧': 'wrench',
  '📦': 'package',
  '🚢': 'ship',
  '🫡': 'saluting_face',
  '🤖': 'robot_face',
};

// Variation-selector-insensitive lookup (U+FE0F rides along inconsistently on both sides).
const stripVS = (s: string): string => s.replace(/️/g, '');
const EMOJI_TO_SLACK_NORMALIZED: Record<string, string> = Object.fromEntries(
  Object.entries(EMOJI_TO_SLACK).map(([k, v]) => [stripVS(k), v]),
);

export function emojiToSlackName(emoji: string): string {
  const trimmed = emoji.trim();
  const direct =
    EMOJI_TO_SLACK[trimmed] ?? EMOJI_TO_SLACK_NORMALIZED[stripVS(trimmed)];
  if (direct) return direct;
  // Already a shortcode ('thumbsup' or ':thumbsup:')?
  const bare = trimmed.replace(/^:|:$/g, '');
  if (/^[a-z0-9_+'-]+$/.test(bare)) return bare;
  return 'thumbsup';
}
