import { HumanMessage } from '@langchain/core/messages';
import { buildGateModel } from './model.js';
import { type Bot, mentionedBots, rosterSummary } from './roster.js';

/** The three-tier response gate: reply, react ("got it" without noise), or stay silent. */
export interface GateDecision {
  action: 'respond' | 'acknowledge' | 'ignore';
  /** The reaction emoji, when action is 'acknowledge'. */
  emoji?: string;
}

const RESPOND: GateDecision = { action: 'respond' };
const IGNORE: GateDecision = { action: 'ignore' };

// Lazy + memoized (the constructor needs ANTHROPIC_API_KEY).
let gateModel: ReturnType<typeof buildGateModel> | undefined;
const model = () => (gateModel ??= buildGateModel());

/**
 * Decide how `bot` should handle the latest channel message: respond, acknowledge (react), or ignore.
 * Hard rules first (free, deterministic), then a cheap LLM for the ambiguous middle. A direct @mention
 * always warrants a reply; the react/ignore choice is for un-addressed messages.
 */
export async function gate(
  bot: Bot,
  text: string,
  opts: { authorBotId?: string; recentContext?: string } = {},
): Promise<GateDecision> {
  if (opts.authorBotId === bot.id) return IGNORE; // never react to your own message

  const mentioned = mentionedBots(text);
  if (mentioned.some((b) => b.id === bot.id)) return RESPOND; // I'm @mentioned → reply
  if (mentioned.length > 0) return IGNORE; // another bot @mentioned, not me → stay out

  // Ambiguous (no bot @mentioned): let the cheap model pick among the three.
  const prompt = `You are ${bot.name}, the team's ${bot.role}, in the #dev channel.
Team: ${rosterSummary()}.
${opts.recentContext ? `Recent context:\n${opts.recentContext}\n` : ''}Latest message:
"${text}"

How should you handle it? Answer with ONE of:
RESPOND — reply, because you're addressed or it's genuinely your lane and you'd add real value.
ACK <emoji> — just acknowledge it with a reaction (an FYI, an announcement, a thanks, a "got it") where
a reply would be noise. Pick a fitting emoji, e.g. ACK 👍 or ACK ✅ or ACK 👀.
IGNORE — it's not for you; stay silent.`;

  try {
    const res = await model().invoke([new HumanMessage(prompt)]);
    const out = (typeof res.content === 'string' ? res.content : JSON.stringify(res.content)).trim();
    const up = out.toUpperCase();
    if (up.startsWith('RESPOND')) return RESPOND;
    if (up.startsWith('ACK')) {
      // Take just the first token after ACK — the model sometimes appends an explanation.
      let emoji = out.replace(/^\s*ack\w*/i, '').trim().split(/\s+/)[0] || '👍';
      if (emoji.length > 8) emoji = '👍'; // looks like stray text, not an emoji
      return { action: 'acknowledge', emoji };
    }
    return IGNORE;
  } catch {
    return IGNORE; // a gate failure must never crash the channel — default to quiet
  }
}
