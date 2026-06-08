import { HumanMessage } from '@langchain/core/messages';
import { buildGateModel } from './model.js';
import { addressedBots, type Bot, rosterSummary } from './roster.js';

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
 * Hard rules first (free, deterministic), then a cheap LLM for the ambiguous middle. Being addressed —
 * by @mention OR by name — always warrants a reply; the react/ignore choice is for un-addressed messages.
 */
export async function gate(
  bot: Bot,
  text: string,
  opts: { authorBotId?: string; recentContext?: string } = {},
): Promise<GateDecision> {
  if (opts.authorBotId === bot.id) return IGNORE; // never react to your own message

  const addressed = addressedBots(text);
  if (addressed.some((b) => b.id === bot.id)) return RESPOND; // I'm addressed (by @ or name) → reply
  if (addressed.length > 0) return IGNORE; // someone else is addressed, not me → stay out

  // Un-addressed: let the cheap model decide, leaning toward responding (silence is the worst outcome).
  const prompt = `You are ${bot.name}, the team's ${bot.role}, in the #dev channel (team: ${rosterSummary()}).
A message was just posted:
"${text}"
${opts.recentContext ? `\nRecent context:\n${opts.recentContext}\n` : ''}
Decide how to handle it. When in doubt, RESPOND — in a small team, silence is worse than a short reply,
and you must not assume a teammate will take it.
- RESPOND: it's a question, a request, or addressed to the team/you, and you can contribute or at least
  answer honestly (even "I'm not sure" is better than silence).
- ACK <emoji>: ONLY for an FYI or announcement that asks nothing of anyone (e.g. "deploy's done",
  "standup moved to 3"). Include one emoji.
- IGNORE: ONLY if it's clearly meant for a specific other person, or it's off-topic chatter you'd add
  nothing to.
Reply with ONLY the token (RESPOND, ACK <emoji>, or IGNORE) and nothing else.`;

  try {
    const res = await model().invoke([new HumanMessage(prompt)]);
    const out = (typeof res.content === 'string' ? res.content : JSON.stringify(res.content)).trim();
    const up = out.toUpperCase();
    // Search (not startsWith): the model sometimes prepends/appends text. RESPOND wins ties.
    if (up.includes('RESPOND')) return RESPOND;
    if (up.includes('IGNORE')) return IGNORE;
    if (up.includes('ACK')) {
      let emoji = out.replace(/^[\s\S]*?ack\w*/i, '').trim().split(/\s+/)[0] || '👍';
      if (emoji.length > 8) emoji = '👍';
      return { action: 'acknowledge', emoji };
    }
    return IGNORE; // unparseable and un-addressed — stay quiet
  } catch {
    return IGNORE; // a gate failure must never crash the channel — default to quiet
  }
}
