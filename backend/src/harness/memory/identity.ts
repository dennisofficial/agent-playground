/**
 * The identity seam + the memory SHARING tiers. A fact's `scope` is exactly one access tier:
 *  - `pair:{bot}:{human}` — 1:1 private; surfaces ONLY in a DM.
 *  - `bot:{bot}`          — bot-wide (that bot, across all its conversations).
 *  - `project:{id}`       — the current workspace/project. DEFAULT tier for work facts.
 *  - `team:{id}`          — the stable team/org, shared across ALL projects.
 * "Who a fact is about" lives in the fact text; the scope decides WHO MAY ACCESS it.
 * (Ported from playground/src/memory/identity.ts.)
 */
export type Tier = 'team' | 'project' | 'bot' | 'private';

export const DEFAULT_TEAM = 'local';
export const DEFAULT_PROJECT = 'local';

export const teamScope = (teamId: string) => `team:${teamId}`;
export const projectScope = (projectId: string) => `project:${projectId}`;
export const botScope = (botId: string) => `bot:${botId}`;
export const pairScope = (botId: string, humanId: string) => `pair:${botId}:${humanId}`;

/** The project id embedded in a `project:<id>` scope, else undefined. */
export function projectLabel(scope: string): string | undefined {
  return scope.startsWith('project:') ? scope.slice('project:'.length) : undefined;
}

export interface Identity {
  /** This bot's id (e.g. "alex"). */
  selfAgent: string;
  /** The stable team/org id — the team tier, shared across all projects. */
  team: string;
  /** The active project/workspace id — the project tier, set per turn. */
  project: string;
  /** Human ids present in the conversation. */
  participants: string[];
  /** The human id speaking this turn — used for the pair scope and `asserted_by`. */
  speaker: string;
  /** The surface/thread id (provenance). */
  surface: string;
  /** True for a shared channel (no 1:1 facts surface); false for a 1:1 DM. */
  isChannel: boolean;
}

/**
 * The scope keys a bot may recall from BY DEFAULT: the current project + the team-wide tier + its own
 * bot-wide tier, plus — only in a 1:1 DM — the present human's 1:1 facts. In a channel, 1:1 facts never
 * surface (the leak guard). Other projects' facts reach the bot only via the separate, read-only
 * labeled cross-project path (`recallOtherProjects`).
 */
export function recallScopes(id: Identity): string[] {
  const scopes = [projectScope(id.project), teamScope(id.team), botScope(id.selfAgent)];
  if (!id.isChannel) {
    for (const h of id.participants) scopes.push(pairScope(id.selfAgent, h));
  }
  return scopes;
}

/** The scope key a new fact is stored under, by tier. `private` = 1:1 with the current speaker. */
export function scopeForTier(tier: Tier, id: Identity): string {
  if (tier === 'project') return projectScope(id.project);
  if (tier === 'team') return teamScope(id.team);
  if (tier === 'bot') return botScope(id.selfAgent);
  return pairScope(id.selfAgent, id.speaker);
}
