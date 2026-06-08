import { HumanMessage } from '@langchain/core/messages';
import { buildGateModel } from './model.js';
import { type Bot, mentionedBots, rosterSummary } from './roster.js';

export type GateDecision = 'respond' | 'ignore';

// Lazy + memoized (the constructor needs ANTHROPIC_API_KEY).
let gateModel: ReturnType<typeof buildGateModel> | undefined;
const model = () => (gateModel ??= buildGateModel());

/**
 * Decide whether `bot` should speak to the latest channel message. Hard rules first (free, deterministic),
 * then a cheap LLM only for the ambiguous middle — "of the bots in this channel, is this mine to answer?"
 * This is the respond/ignore decision the conductor runs per bot before invoking a full turn.
 */
export async function gate(
  bot: Bot,
  text: string,
  opts: { authorBotId?: string; recentContext?: string } = {},
): Promise<GateDecision> {
  if (opts.authorBotId === bot.id) return 'ignore'; // never react to your own message

  const mentioned = mentionedBots(text);
  if (mentioned.some((b) => b.id === bot.id)) return 'respond'; // I'm @mentioned → respond
  if (mentioned.length > 0) return 'ignore'; // another bot @mentioned, not me → stay out

  // Ambiguous (no bot @mentioned): let the cheap model judge relevance.
  const prompt = `You are ${bot.name}, the team's ${bot.role}, in the #dev channel.
Team: ${rosterSummary()}.
${opts.recentContext ? `Recent context:\n${opts.recentContext}\n` : ''}Latest message:
"${text}"

Should YOU respond? Respond ONLY if you're addressed or it's genuinely your lane and you'd add real
value — a teammate may be better suited, and staying silent is fine. Answer with exactly one word:
RESPOND or IGNORE.`;

  try {
    const res = await model().invoke([new HumanMessage(prompt)]);
    const out = (
      typeof res.content === 'string' ? res.content : JSON.stringify(res.content)
    ).toUpperCase();
    return out.includes('RESPOND') ? 'respond' : 'ignore';
  } catch {
    return 'ignore'; // a gate failure must never crash the channel — default to quiet
  }
}
