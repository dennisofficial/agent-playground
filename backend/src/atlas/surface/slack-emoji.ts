/**
 * Unicode emoji → Slack shortcode names for `reactions.add` — a trimmed clean-room copy of v1's map
 * (the reactions the brain/driver actually emit). Bare shortcodes pass through; unknowns fall back to
 * `thumbsup`. Variation-selector-insensitive (U+FE0F rides along inconsistently).
 */
const EMOJI_TO_SLACK: Record<string, string> = {
  '👍': 'thumbsup',
  '👀': 'eyes',
  '✅': 'white_check_mark',
  '🎉': 'tada',
  '🚀': 'rocket',
  '🔥': 'fire',
  '💭': 'thought_balloon',
  '🤔': 'thinking_face',
  '⚠️': 'warning',
  '❌': 'x',
  '🐛': 'bug',
  '🛠️': 'hammer_and_wrench',
  '🤖': 'robot_face',
  '🫡': 'saluting_face',
};

const stripVS = (s: string): string => s.replace(/️/g, '');
const NORMALIZED: Record<string, string> = Object.fromEntries(
  Object.entries(EMOJI_TO_SLACK).map(([k, v]) => [stripVS(k), v]),
);

export function emojiToSlackName(emoji: string): string {
  const trimmed = emoji.trim();
  const direct = EMOJI_TO_SLACK[trimmed] ?? NORMALIZED[stripVS(trimmed)];
  if (direct) return direct;
  const bare = trimmed.replace(/^:|:$/g, '');
  if (/^[a-z0-9_+'-]+$/.test(bare)) return bare;
  return 'thumbsup';
}
