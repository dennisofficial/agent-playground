/**
 * The identity seam: who is present *right now*, resolved per turn. This is what lets fact memory be
 * scoped to ENTITIES (people, teams, the company) and recalled by PARTICIPANTS — never by the Slack
 * channel/thread id. The conductor sets a CLI stub today; a Slack adapter fills real ids later.
 *
 * Two independent axes on every fact (kept separate on purpose):
 *  - SUBJECT  (`subject_scope`): who/what the fact is about. Follows the entity across every surface.
 *  - VISIBILITY: who may *surface* it. `company` = any agent, anywhere; `private` = only in a 1:1 with
 *    the subject. So a DM-private fact about Dennis is never surfaced into a group channel — even
 *    though its subject (Dennis) is present there.
 */
export type Visibility = 'private' | 'company';
export type FactKind = 'work' | 'personal';

// Scope string format: `person:<id>` | `team:<id>` | `company:<id>` | `agent:<id>` | `global`.
export const personScope = (id: string) => `person:${id}`;
export const companyScope = (id: string) => `company:${id}`;
export const teamScope = (id: string) => `team:${id}`;

export interface Identity {
  /** Humans present, as `person:<id>` — recall pulls facts about each of them. */
  participants: string[];
  /** The person speaking *this* turn, as `person:<id>` — used for `asserted_by` and as the default
   *  subject of a new fact ("remember this about the person I'm talking with"). */
  speaker: string;
  /** `team:<id>` if this surface maps to a team. */
  team?: string;
  /** `company:<id>` — the shared scope. */
  company: string;
  /** The thread/surface id — provenance + 1:1 detection only; NEVER a scope key. */
  surface: string;
  /** This agent's id — `owner_agent` on writes. */
  selfAgent: string;
}

/** v0 CLI stub: one human (Dennis), one company, a DM-like 1:1 surface. Slack fills real ids later. */
export const CLI_IDENTITY: Identity = {
  participants: [personScope('dennis')],
  speaker: personScope('dennis'),
  company: companyScope('local'),
  surface: 'dev:root',
  selfAgent: 'alex',
};

/**
 * Pull identity out of a run's config (set by the conductor / Slack adapter), falling back to the CLI
 * stub. Defensive so a memory tool still works if a caller forgets to thread it through.
 */
export function getIdentity(config?: { configurable?: Record<string, unknown> }): Identity {
  return (config?.configurable?.identity as Identity | undefined) ?? CLI_IDENTITY;
}

/** Subject scopes whose facts are candidates this turn: every participant + team + company + global. */
export function recallScopes(id: Identity): string[] {
  return [...id.participants, ...(id.team ? [id.team] : []), id.company, 'global'];
}

/**
 * Default visibility for a new fact, keyed off its kind: WORK facts are company-shareable (so the
 * team can use them in the channel — "Dennis prefers TypeScript"); PERSONAL facts are private (they
 * only surface in a 1:1 with the subject — "Dennis has a cat"). The caller can always override.
 */
export function defaultVisibility(kind: FactKind): Visibility {
  return kind === 'personal' ? 'private' : 'company';
}

/**
 * The access gate, separate from subject scoping: may this fact be surfaced in the current context?
 * `company` facts: anywhere. `private` facts: only in a 1:1 with the subject (the CLI is a 1:1 with its
 * single participant). This is what keeps DM-private facts out of group channels.
 */
export function canSurface(
  fact: { subject_scope: string; visibility: Visibility },
  id: Identity,
): boolean {
  if (fact.visibility === 'company') return true;
  const isOneOnOne = id.participants.length === 1;
  return isOneOnOne && id.participants.includes(fact.subject_scope);
}
