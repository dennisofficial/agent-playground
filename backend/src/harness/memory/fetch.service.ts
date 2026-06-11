import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Fact } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import {
  Identity,
  projectScope,
  recallProjects,
  recallScopes,
} from '../domain/identity';
import type { EmployeeDefinition } from '../employees/employee.types';
import { SemanticMemory } from './semantic-memory';
import { TaskStore } from './task-store';

// Cap on reminders injected per turn, so a growing plate doesn't monotonically bloat context.
const REMINDER_CAP = 12;

/**
 * The pre-LLM memory FETCH — the read half of deterministic memory. Before a bot thinks, this pulls
 * the facts + open tasks relevant to what's being said and hands them back as a `recalled` block the
 * graph injects into the model's context. So the bot always walks in knowing, instead of
 * (un)reliably choosing to call `recall` itself. Each half has a cheap programmatic skip so an empty
 * store costs nothing (no embeddings call).
 * (Ported from playground/src/memory/fetch.ts; the ticket-workspace block is deliberately dropped —
 * worktrees/board are not in this pass.)
 */
@Injectable()
export class FetchService {
  constructor(
    @InjectRepository(Fact) private readonly facts: Repository<Fact>,
    private readonly semantic: SemanticMemory,
    private readonly tasks: TaskStore,
  ) {}

  /** Programmatic empty-skip: does this identity have ANY live fact in its recall scopes? */
  private async hasFacts(id: Identity): Promise<boolean> {
    const scopes = recallScopes(id);
    if (scopes.length === 0) return false;
    const rows: unknown[] = await this.facts.manager.query(
      `SELECT 1 FROM facts WHERE scope = ANY($1) AND deleted_at IS NULL LIMIT 1`,
      [scopes],
    );
    return rows.length > 0;
  }

  /** Programmatic empty-skip for the cross-project block: does ANY OTHER project hold a live fact?
   * "Other" = not recallable this turn (a DM recalls every shared project directly). */
  private async hasOtherProjectFacts(id: Identity): Promise<boolean> {
    const rows: unknown[] = await this.facts.manager.query(
      `SELECT 1 FROM facts WHERE scope LIKE 'project:%' AND scope <> ALL($1::text[]) AND deleted_at IS NULL LIMIT 1`,
      [recallProjects(id).map(projectScope)],
    );
    return rows.length > 0;
  }

  /**
   * Build the `recalled` context block for `bot`, given this turn's incoming text as the retrieval
   * query. Facts: embedding top-k over the current project + team, plus a small, strongly-relevant
   * set from OTHER projects rendered LABELED with their project. Tasks: the open plate for this bot
   * (the team lead sees the whole team's). Returns '' when there's nothing — the caller MUST
   * still write that empty string into state so a stale recall from a prior turn never lingers.
   */
  async fetchContext(
    bot: EmployeeDefinition,
    query: string,
    id: Identity,
  ): Promise<string> {
    const parts: string[] = [];

    // The two programmatic empty-skips are independent — run them in parallel. Cross-project recall
    // is gated INDEPENDENTLY of hasFacts: a clean-slate current project must still surface
    // strongly-relevant facts from other projects.
    const [hasOwn, hasOther] = query.trim()
      ? await Promise.all([this.hasFacts(id), this.hasOtherProjectFacts(id)])
      : [false, false];

    // Embed the query ONCE and hand the vector to both recall paths (they used to embed the same
    // text twice). Retrieval failure (e.g. an embeddings outage) must DEGRADE to empty recall, not
    // abort the turn — a throw here would fail the whole respond turn; match reconcile's posture.
    let qv: string | undefined;
    if (hasOwn || hasOther) {
      try {
        qv = await this.semantic.embed(query);
      } catch {
        /* degrade to no recall */
      }
    }

    // Reminders span every recallable project (one in a channel; the shared set in a DM).
    const projects = recallProjects(id);
    const [facts, others, plates] = await Promise.all([
      qv && hasOwn
        ? this.semantic
            .recall(query, id, undefined, undefined, qv)
            .catch(() => [])
        : [],
      qv && hasOther
        ? this.semantic
            .recallOtherProjects(query, id, { precomputed: qv })
            .catch(() => [])
        : [],
      // Reminders: this bot's own plate — except the team lead, who sees the whole team's.
      Promise.all(
        projects.map((project) =>
          bot.teamLead
            ? this.tasks.openTasks(id.team, project)
            : this.tasks.listTasks({
                team: id.team,
                project,
                status: 'open',
                owner: bot.id,
              }),
        ),
      ),
    ]);
    const plate = plates.flat();

    if (facts.length > 0) {
      parts.push(
        `What you already know:\n${facts.map((f) => `- ${f.fact}`).join('\n')}`,
      );
    }
    if (others.length > 0) {
      parts.push(
        `From other projects (for reference):\n${others.map((o) => `- [${o.project}] ${o.fact.fact}`).join('\n')}`,
      );
    }
    if (plate.length > 0) {
      const shown = plate.slice(0, REMINDER_CAP);
      const more = plate.length - shown.length;
      const lines = shown
        .map(
          (t) =>
            `- [#${t.id}] ${t.description}${bot.teamLead ? ` (→ ${t.owner})` : ''}${projects.length > 1 ? ` [${t.project}]` : ''}`,
        )
        .join('\n');
      parts.push(
        `${bot.teamLead ? 'Open reminders (team)' : 'On your plate'}:\n${lines}${more > 0 ? `\n…and ${more} more` : ''}`,
      );
    }

    return parts.join('\n\n');
  }
}
