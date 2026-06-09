import type { Employee } from '../employees/index.js';
import { listTicketWorkspaces } from '../workspace.js';
import { getDb } from './db.js';
import { type Identity, projectScope, recallScopes } from './identity.js';
import { recall, recallOtherProjects } from './semantic.js';
import { listTasks, openTasks } from './tasks.js';

// Cap on reminders injected per turn, so a growing plate doesn't monotonically bloat context.
const REMINDER_CAP = 12;

/**
 * The pre-LLM memory FETCH — the read half of deterministic memory. Before a bot thinks, this pulls the
 * facts + open tasks relevant to what's being said and hands them back as a `recalled` block the graph
 * injects into the model's context. So the bot always walks in knowing, instead of (un)reliably choosing
 * to call `recall` itself. Each half has a cheap programmatic skip so an empty store costs nothing.
 */

/** Programmatic empty-skip: does this identity have ANY live fact in its recall scopes? */
function hasFacts(id: Identity): boolean {
  const scopes = recallScopes(id);
  if (scopes.length === 0) return false;
  const placeholders = scopes.map(() => '?').join(',');
  const row = getDb()
    .prepare(`SELECT 1 FROM facts WHERE scope IN (${placeholders}) AND deleted_at IS NULL LIMIT 1`)
    .get(...scopes);
  return !!row;
}

/** Programmatic empty-skip for the cross-project block: does ANY OTHER project hold a live fact? */
function hasOtherProjectFacts(id: Identity): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM facts WHERE scope LIKE 'project:%' AND scope != ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(projectScope(id.project));
  return !!row;
}

/**
 * Build the `recalled` context block for `bot`, given this turn's incoming text as the retrieval query.
 * Facts: embedding top-k via `recall` over the current project + team (skipped when those scopes are
 * empty), plus a small, strongly-relevant set from OTHER projects rendered LABELED with their project so
 * the bot can reference a past project without mistaking it for the current one. Tasks: the open board for
 * this bot + unassigned (skipped when there are none). Returns '' when there's nothing — the caller MUST
 * still write that empty string into state so a stale recall from a prior turn never lingers.
 */
export async function fetchContext(bot: Employee, query: string, id: Identity): Promise<string> {
  const parts: string[] = [];

  if (query.trim() && hasFacts(id)) {
    try {
      const facts = await recall(query, id);
      if (facts.length > 0) {
        parts.push(`What you already know:\n${facts.map((f) => `- ${f.fact}`).join('\n')}`);
      }
    } catch {
      // Retrieval failure (e.g. an embeddings outage) must DEGRADE to empty recall, not abort the turn:
      // a throw here would propagate out of the fetch node and the conductor would fail the whole respond
      // turn (no reply), whereas reconcile already swallows its errors. Match that posture on the read side.
    }
  }

  // Cross-project recall — gated INDEPENDENTLY of hasFacts: a clean-slate current project (empty own+team
  // scopes) must still surface strongly-relevant facts from other projects, each labeled with its project.
  if (query.trim() && hasOtherProjectFacts(id)) {
    try {
      const others = await recallOtherProjects(query, id);
      if (others.length > 0) {
        parts.push(
          `From other projects (for reference):\n${others
            .map((o) => `- [${o.project}] ${o.fact.fact}`)
            .join('\n')}`,
        );
      }
    } catch {
      // Same degrade-to-empty posture as the in-project recall above.
    }
  }

  // Reminders: this bot's own plate — except the scrum master, who walks in seeing the whole team's.
  const plate = bot.scrumMaster
    ? openTasks(id.project)
    : listTasks({ project: id.project, status: 'open', owner: bot.id });
  if (plate.length > 0) {
    const shown = plate.slice(0, REMINDER_CAP);
    const more = plate.length - shown.length;
    const lines = shown
      .map((t) => `- [#${t.id}] ${t.description}${bot.scrumMaster ? ` (→ ${t.owner})` : ''}`)
      .join('\n');
    parts.push(
      `${bot.scrumMaster ? 'Open reminders (team)' : 'On your plate'}:\n${lines}${
        more > 0 ? `\n…and ${more} more` : ''
      }`,
    );
  }

  // Ticket workspaces: your own branch + worktree per ticket you're building, and who else is on it — so
  // you know which coworkers to coordinate with on the shared branch (see the team rules).
  const mine = listTicketWorkspaces(bot.id);
  if (mine.length > 0) {
    const all = listTicketWorkspaces();
    parts.push(
      `Your ticket workspaces:\n${mine
        .map((w) => {
          const coworkers = all
            .filter((o) => o.ticketId === w.ticketId && o.owner !== bot.id)
            .map((o) => o.owner);
          return `- ${w.ticketId} on ${w.branch}${
            coworkers.length
              ? ` — also building it: ${coworkers.join(', ')} (coordinate via @mention)`
              : ''
          }`;
        })
        .join('\n')}`,
    );
  }

  return parts.join('\n\n');
}
