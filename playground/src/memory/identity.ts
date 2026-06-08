/**
 * The identity seam + the three memory SHARING tiers. A fact's `scope` is exactly one access tier:
 *  - `pair:{bot}:{human}` — 1:1 private (a bot's relationship with one human); surfaces ONLY in a DM.
 *  - `bot:{bot}`          — bot-wide (that bot, across all its conversations). Lightly used: most role
 *                           knowledge lives in the system prompt + skills, not learned memory.
 *  - `company:{id}`       — shared by all bots in the workspace.
 * "Who a fact is about" lives in the fact text; the scope decides WHO MAY ACCESS it.
 */
export type Tier = 'company' | 'bot' | 'private';

export const companyScope = (companyId: string) => `company:${companyId}`;
export const botScope = (botId: string) => `bot:${botId}`;
export const pairScope = (botId: string, humanId: string) => `pair:${botId}:${humanId}`;

export interface Identity {
  /** This bot's id (e.g. "alex"). */
  selfAgent: string;
  /** The project/workspace id (e.g. "local") — the company tier. */
  company: string;
  /** Human ids present in the conversation (e.g. ["dennis"]). */
  participants: string[];
  /** The human id speaking this turn — used for the pair scope and `asserted_by`. */
  speaker: string;
  /** The surface/thread id (provenance). */
  surface: string;
  /** True for a shared channel (no 1:1 facts surface); false for a 1:1 DM. */
  isChannel: boolean;
}

/** v0 CLI stub: bot Alex, project "local", Dennis present, in a channel. Slack fills real ids later. */
export const CLI_IDENTITY: Identity = {
  selfAgent: 'alex',
  company: 'local',
  participants: ['dennis'],
  speaker: 'dennis',
  surface: 'dev:root',
  isChannel: true,
};

/** Pull identity out of a run's config (set by the conductor / Slack adapter), falling back to the stub. */
export function getIdentity(config?: { configurable?: Record<string, unknown> }): Identity {
  return (config?.configurable?.identity as Identity | undefined) ?? CLI_IDENTITY;
}

/**
 * The scope keys a bot may recall from: company-wide + its own bot-wide, plus — only in a 1:1 DM
 * (`!isChannel`) — the present human's 1:1 facts. In a channel, 1:1 facts never surface (the leak guard).
 */
export function recallScopes(id: Identity): string[] {
  const scopes = [companyScope(id.company), botScope(id.selfAgent)];
  if (!id.isChannel) {
    for (const h of id.participants) scopes.push(pairScope(id.selfAgent, h));
  }
  return scopes;
}

/** The scope key a new fact is stored under, by tier. `private` = 1:1 with the current speaker. */
export function scopeForTier(tier: Tier, id: Identity): string {
  if (tier === 'company') return companyScope(id.company);
  if (tier === 'bot') return botScope(id.selfAgent);
  return pairScope(id.selfAgent, id.speaker);
}
