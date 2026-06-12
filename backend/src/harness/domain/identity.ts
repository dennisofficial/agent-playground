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
export const pairScope = (botId: string, humanId: string) =>
  `pair:${botId}:${humanId}`;

/** The project id embedded in a `project:<id>` scope, else undefined. */
export function projectLabel(scope: string): string | undefined {
  return scope.startsWith('project:')
    ? scope.slice('project:'.length)
    : undefined;
}

export interface Identity {
  /** This bot's id (e.g. "alex"). */
  selfAgent: string;
  /** The stable team/org id — the team tier, shared across all projects. */
  team: string;
  /** The active project/workspace id — the WRITE target for project facts in a channel, and the
   * home for this turn's reminders. In a DM this is only the default home (a DM is workspace-level,
   * not project-bound); project writes there must NAME their project (see `scopeForTier`). */
  project: string;
  /** The project scopes RECALLABLE this turn. A channel recalls its own project (`[project]`, the
   * default); a DM recalls every project the bot SHARES with the present humans — a DM is about
   * anything you both work on. */
  projects?: string[];
  /** Human ids present in the conversation. */
  participants: string[];
  /** The human id speaking this turn — used for the pair scope and `asserted_by`. */
  speaker: string;
  /** The surface/thread id (provenance). */
  surface: string;
  /** True for a shared channel (no 1:1 facts surface); false for a 1:1 DM. */
  isChannel: boolean;
}

/** v0 stub: bot Alex, team+project "local", Dennis present, in a channel. Real surfaces fill ids later. */
export const CLI_IDENTITY: Identity = {
  selfAgent: 'alex',
  team: DEFAULT_TEAM,
  project: DEFAULT_PROJECT,
  participants: ['dennis'],
  speaker: 'dennis',
  surface: 'dev:root',
  isChannel: true,
};

/** Pull identity out of a run's config (set by the conductor / surface adapter), falling back to the stub. */
export function getIdentity(config?: {
  configurable?: Record<string, unknown>;
}): Identity {
  return (
    (config?.configurable?.identity as Identity | undefined) ?? CLI_IDENTITY
  );
}

/**
 * The scope keys a bot may recall from BY DEFAULT: the current project + the team-wide tier + its own
 * bot-wide tier, plus — only in a 1:1 DM — the present human's 1:1 facts. In a channel, 1:1 facts never
 * surface (the leak guard). Other projects' facts reach the bot only via the separate, read-only
 * labeled cross-project path (`recallOtherProjects`).
 */
export function recallScopes(id: Identity): string[] {
  const scopes = [
    ...recallProjects(id).map(projectScope),
    teamScope(id.team),
    botScope(id.selfAgent),
  ];
  if (!id.isChannel) {
    for (const h of id.participants) scopes.push(pairScope(id.selfAgent, h));
  }
  return scopes;
}

/** The project ids recallable this turn (see `Identity.projects`). */
export function recallProjects(id: Identity): string[] {
  return id.projects?.length ? [...new Set(id.projects)] : [id.project];
}

/**
 * The scope key a new fact is stored under, by tier. `private` = 1:1 with the current speaker.
 *
 * Project tier: a channel writes to ITS project (`namedProject` ignored — a room can't write into
 * another room's project). A DM is project-less, so a project fact there must NAME a project the
 * pair actually shares; un-named or unknown falls back to the PAIR scope — the leak-safe default
 * (a misjudged "project" fact stays 1:1 instead of surfacing in some group chat).
 */
export interface ParsedScope {
  tier: Tier;
  /** Present when `tier === 'project'`. */
  projectId?: string;
  /** Present when `tier === 'bot'` or `tier === 'private'`. */
  botId?: string;
  /** Present when `tier === 'private'` (the human participant in the pair). */
  humanId?: string;
}

/**
 * Inverse of the scope constructors: parses a stored `scope` string back to its tier and
 * sub-components. Unknown or malformed scopes fall back to `{ tier: 'team' }` — the safest
 * choice (broadest share scope, no agent or project ids leaked from a garbage string).
 */
export function parseScope(scope: string): ParsedScope {
  if (scope.startsWith('team:')) return { tier: 'team' };
  if (scope.startsWith('project:'))
    return { tier: 'project', projectId: scope.slice('project:'.length) };
  if (scope.startsWith('bot:'))
    return { tier: 'bot', botId: scope.slice('bot:'.length) };
  if (scope.startsWith('pair:')) {
    const rest = scope.slice('pair:'.length);
    const colon = rest.indexOf(':');
    if (colon >= 0)
      return {
        tier: 'private',
        botId: rest.slice(0, colon),
        humanId: rest.slice(colon + 1),
      };
    return { tier: 'private', botId: rest };
  }
  return { tier: 'team' };
}

export function scopeForTier(
  tier: Tier,
  id: Identity,
  namedProject?: string,
): string {
  if (tier === 'project') {
    if (id.isChannel) return projectScope(id.project);
    const named = namedProject?.trim().toLowerCase();
    if (named && recallProjects(id).includes(named)) return projectScope(named);
    return pairScope(id.selfAgent, id.speaker);
  }
  if (tier === 'team') return teamScope(id.team);
  if (tier === 'bot') return botScope(id.selfAgent);
  return pairScope(id.selfAgent, id.speaker);
}
