/**
 * The identity seam + the memory SHARING tiers. A fact's `scope` is exactly one access tier:
 *  - `pair:{bot}:{human}` — 1:1 private (a bot's relationship with one human); surfaces ONLY in a DM.
 *  - `bot:{bot}`          — bot-wide (that bot, across all its conversations). Lightly used: most role
 *                           knowledge lives in the system prompt + skills, not learned memory.
 *  - `project:{id}`       — the current workspace/project: its repo/stack/goals/decisions. The DEFAULT
 *                           tier for work facts; scoped so one project's detail doesn't bleed into another.
 *  - `team:{id}`          — the stable team/org, shared across ALL projects: roles, who's-who, the boss's
 *                           standing preferences. Follows the team everywhere.
 * "Who a fact is about" lives in the fact text; the scope decides WHO MAY ACCESS it. (The `private` tier
 * is deferred — its plumbing stays, but no 1:1/DM surface exists yet.)
 */
export type Tier = 'team' | 'project' | 'bot' | 'private';

/** Default team/org id (v0 CLI). */
export const DEFAULT_TEAM = 'local';
/** Default project id (v0 CLI — until the channel→project mapping lands). */
export const DEFAULT_PROJECT = 'local';

export const teamScope = (teamId: string) => `team:${teamId}`;
export const projectScope = (projectId: string) => `project:${projectId}`;
export const botScope = (botId: string) => `bot:${botId}`;
export const pairScope = (botId: string, humanId: string) => `pair:${botId}:${humanId}`;

/** The project id embedded in a `project:<id>` scope, else undefined (team/bot/pair scopes have none). */
export function projectLabel(scope: string): string | undefined {
  return scope.startsWith('project:') ? scope.slice('project:'.length) : undefined;
}

export interface Identity {
  /** This bot's id (e.g. "alex"). */
  selfAgent: string;
  /** The stable team/org id (e.g. "local") — the team tier, shared across all projects. */
  team: string;
  /** The active project/workspace id (e.g. "local") — the project tier, set per turn. */
  project: string;
  /** Human ids present in the conversation (e.g. ["dennis"]). */
  participants: string[];
  /** The human id speaking this turn — used for the pair scope and `asserted_by`. */
  speaker: string;
  /** The surface/thread id (provenance). */
  surface: string;
  /** True for a shared channel (no 1:1 facts surface); false for a 1:1 DM. */
  isChannel: boolean;
}

/** v0 CLI stub: bot Alex, team+project "local", Dennis present, in a channel. Slack fills real ids later. */
export const CLI_IDENTITY: Identity = {
  selfAgent: 'alex',
  team: DEFAULT_TEAM,
  project: DEFAULT_PROJECT,
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
 * The scope keys a bot may recall from BY DEFAULT: the current project + the team-wide tier + its own
 * bot-wide tier, plus — only in a 1:1 DM (`!isChannel`) — the present human's 1:1 facts. In a channel,
 * 1:1 facts never surface (the leak guard). Other projects' facts are deliberately NOT here — they reach
 * the bot only through the separate, read-only labeled cross-project path (`recallOtherProjects`), so
 * write-targeting (update/forget/dedup) can never touch another project's facts.
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
