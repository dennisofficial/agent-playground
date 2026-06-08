import { HumanMessage } from '@langchain/core/messages';
import { buildExtractModel } from '../model.js';
import type { Bot } from '../roster.js';
import { type Identity, type Tier } from './identity.js';
import { remember } from './semantic.js';

/**
 * The memory gate: a cheap background pass that distills a durable fact from a channel message a bot
 * received — even one it didn't answer — so bots learn while silent ("memory updates regardless of
 * response decision"). Conservative by design: most messages yield nothing. Fire-and-forget — every
 * failure is swallowed so it can never affect the channel.
 */

let extractModel: ReturnType<typeof buildExtractModel> | undefined;
const model = () => (extractModel ??= buildExtractModel());

export async function extractAndRemember(opts: {
  bot: Bot;
  author: string;
  text: string;
  identity: Identity;
}): Promise<void> {
  try {
    const prompt = `You are ${opts.bot.name}, the team's ${opts.bot.role}, listening in the #dev channel.
Speaker: ${opts.author}.

From the message below, extract AT MOST ONE durable fact worth remembering long-term — a stable
preference, a decision, a role, or a company fact. Do NOT extract chatter, greetings, questions, task
instructions, or coding-style/conventions (those are already part of who you are). If there is nothing
worth saving, reply with exactly: NONE

Otherwise reply on one line: SAVE | <tier> | <the fact, in plain words>
where <tier> is one of:
  company  — all bots should know it (DEFAULT for work facts and the boss's preferences)
  private  — personal or sensitive; keep it to a 1:1 with this person
  bot      — only relevant to you

Message: "${opts.text}"`;

    const res = await model().invoke([new HumanMessage(prompt)]);
    const out = (
      typeof res.content === 'string' ? res.content : JSON.stringify(res.content)
    ).trim();
    if (!out.toUpperCase().startsWith('SAVE')) return;

    const parts = out.split('|').map((s) => s.trim());
    const tierRaw = (parts[1] ?? '').toLowerCase();
    const fact = parts.slice(2).join('|').trim();
    if (!fact) return;
    const tier: Tier = tierRaw === 'private' ? 'private' : tierRaw === 'bot' ? 'bot' : 'company';
    await remember({ fact, tier, id: opts.identity });
  } catch {
    /* fire-and-forget: the memory gate must never break the channel */
  }
}
