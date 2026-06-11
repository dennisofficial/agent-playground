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

/**
 * Harness Markdown → Slack mrkdwn for outbound posts. The LLMs emit standard Markdown
 * (`**bold**`, `[label](url)`, `# headers`, tables); Slack renders mrkdwn (`*bold*`,
 * `<url|label>`, no headers, NO tables) and shows everything else literally. Two passes, both
 * code-fence-aware: ① structures mrkdwn can't express at all (tables → aligned monospace blocks,
 * horizontal rules → a divider line); ② inline syntax. Code contents are never rewritten — the
 * only code-segment change is stripping fence language tags, which mrkdwn renders as text.
 */
export function translateOutbound(text: string): string {
  const stage1 = mapSegments(text, (prose) => convertTables(convertRules(prose)), (c) => c);
  return mapSegments(stage1, translateProse, stripFenceLang);
}

/** Capture-group split: fenced blocks + inline code land at odd indices, prose at even. */
function mapSegments(
  text: string,
  proseFn: (s: string) => string,
  codeFn: (s: string) => string,
): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts.map((part, i) => (i % 2 === 1 ? codeFn(part) : proseFn(part))).join('');
}

/** ```lang fences: mrkdwn has no syntax highlighting and renders the tag as literal first-line
 * text — drop it. */
function stripFenceLang(code: string): string {
  return code.replace(/^```[^\n`]+\n/, '```\n');
}

/** `---` / `***` / `___` rules → a divider line (mrkdwn has no hr). */
function convertRules(seg: string): string {
  return seg.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '──────────');
}

// ── Markdown tables → aligned monospace blocks (mrkdwn has no tables at all) ────────────────────

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

function convertTables(seg: string): string {
  const lines = seg.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (TABLE_ROW.test(lines[i]) && TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      const rows = [parseTableRow(lines[i])];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j])) {
        rows.push(parseTableRow(lines[j]));
        j++;
      }
      out.push(renderTable(rows));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(...rows.map((r) => (r[c] ?? '').length)),
  );
  const fmt = (r: string[]): string =>
    widths.map((w, c) => (r[c] ?? '').padEnd(w)).join(' | ').trimEnd();
  const divider = widths.map((w) => '-'.repeat(w)).join('-+-');
  const body = [fmt(rows[0]), divider, ...rows.slice(1).map(fmt)];
  return '```\n' + body.join('\n') + '\n```';
}

function translateProse(seg: string): string {
  return (
    seg
      // Images BEFORE links (the ![ syntax contains the link syntax). A real URL becomes a plain
      // link (Slack unfurls images); a relative/fake path keeps just the alt text — mrkdwn can't
      // render either, and the persona rules tell bots not to emit these at all.
      .replace(
        /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
        (_m, alt: string, url: string) => (alt ? `<${url}|${alt}>` : url),
      )
      .replace(/!\[([^\]]*)\]\([^\s)]*\)/g, '$1')
      // [label](url) → <url|label>
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>')
      // Bullets BEFORE italic — a leading '* ' must not look like an emphasis opener.
      .replace(/^(\s*)[*-]\s+/gm, '$1• ')
      // Italic FIRST among the star rules: it can't match a ** pair or a bare # header line,
      // but running it later would re-eat the *x* those rules produce. Content must start and
      // end non-space and contain no '*' (`2 * 3 * 4` is math, not emphasis).
      .replace(/(?<![\w*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![\w*])/g, '_$1_')
      // ATX headers → a bold line (mrkdwn has no headers)
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      // Bold: **x** / __x__ → *x*
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '*$1*')
      // Strikethrough: ~~x~~ → ~x~
      .replace(/~~([^~]+)~~/g, '~$1~')
  );
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
