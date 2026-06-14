import { HumanMessage } from '@langchain/core/messages';
import {
  Runnable,
  type RunnableConfig,
  RunnableLambda,
  RunnableSequence,
} from '@langchain/core/runnables';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { Identity, recallProjects } from '../domain/identity';
import { titleCase } from '../domain/text';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { Decision, MemoryMetricsService } from './memory-metrics.service';
import { MEMORY_PROMPT, TASK_PROMPT } from './memory.prompts';
import { SemanticMemory } from './semantic-memory';
import { TaskStore } from './task-store';

/**
 * The post-LLM RECONCILE — after a bot's turn, two cheap Haiku passes look at the turn + the
 * CURRENT state and emit ops: memory (suggestion-only — no writes) and tasks (add/complete/drop).
 * State-aware by design — they're shown what's already stored.
 *
 * Consent model: `reconcileMemory` is READ-ONLY — it surfaces a short human-readable
 * suggestion block (returned, stored in `memorySuggestions`) instead of writing to the store.
 * The agent commits via its own `remember` / `update_memory` / `forget` tools — the only write path.
 * (Ported from playground/src/memory/reconcile.ts; logBus debug rows became Logger lines.)
 */

// How many accessible facts to show the memory-reconcile model as "what you currently know".
// Wide enough to detect contradictions / supersedes without reading the whole store.
const RECONCILE_RECALL_LIMIT = 25;
// Lower floor than fetch: reconcile wants to SEE marginal neighbors so it can spot contradictions.
const RECONCILE_FLOOR = 0.15;

// Narrowed schema. add/update carry `kind` to force a self-check (the model must name
// which of the three qualifying classes each suggestion falls into). delete is always a correction.
const MemorySchema = z.object({
  reasoning: z
    .string()
    .describe(
      'one short sentence: which qualifying class triggered the suggestion, or "nothing qualifies" if the turn contains none of the three classes',
    ),
  add: z
    .array(
      z.object({
        kind: z
          .enum(['correction', 'decision', 'preference'])
          .describe(
            'which of the three qualifying classes justifies this suggestion — the model must name one',
          ),
        fact: z
          .string()
          .describe(
            'the bare atomic claim — the decision/preference itself, no interpretation, consequences, or rationale',
          ),
        tier: z.enum(['team', 'project', 'bot', 'private']),
        project: z
          .string()
          .optional()
          .describe(
            'ONLY for tier "project" in a DM: which project the fact belongs to (one of the projects listed in the note)',
          ),
        authorId: z.string().describe('id of the HUMAN who stated it'),
        supersedes: z
          .number()
          .optional()
          .describe(
            'the #id of an existing fact this one contradicts/replaces — set it so the stale fact is not kept alongside',
          ),
      }),
    )
    .describe(
      'facts to suggest remembering; ONLY for the three qualifying classes; [] if none',
    ),
  update: z
    .array(
      z.object({
        kind: z
          .enum(['correction', 'decision', 'preference'])
          .describe('which qualifying class this update falls into'),
        id: z
          .number()
          .describe(
            'the #id of the existing fact (from the list above) to update',
          ),
        newFact: z
          .string()
          .describe(
            'the corrected statement, stated minimally — one bare atomic claim',
          ),
      }),
    )
    .describe('existing facts (by #id) to suggest updating; [] if none'),
  delete: z
    .array(
      z.object({
        id: z
          .number()
          .describe(
            'the #id of the existing fact (from the list above) that is now explicitly contradicted',
          ),
      }),
    )
    .describe(
      'existing facts (by #id) to suggest forgetting — ONLY when an explicit correction contradicts them; [] if none',
    ),
});
type MemoryResult = z.infer<typeof MemorySchema>;

const TaskSchema = z.object({
  reasoning: z
    .string()
    .describe('one short sentence on what changed on the plates, if anything'),
  add: z
    .array(
      z.object({
        description: z.string(),
        owner: z
          .string()
          .describe(
            'id of who is RESPONSIBLE — the teammate who committed ("I\'ll…" → themselves) or who it was handed to',
          ),
        project: z
          .string()
          .optional()
          .describe(
            'ONLY in a DM: which project this reminder belongs to (one of the projects listed in the note). Omit for a general reminder.',
          ),
      }),
    )
    .describe(
      'NEW commitments to future work made THIS turn, especially DEFERRED ones ("after I finish X", "later", "once Y is up"); [] if none',
    ),
  complete: z
    .array(z.object({ id: z.number() }))
    .describe(
      'open reminders (by #id above) this turn shows are now DONE; [] if none',
    ),
  drop: z
    .array(z.object({ id: z.number() }))
    .describe('open reminders (by #id above) no longer relevant; [] if none'),
});
type TaskResult = z.infer<typeof TaskSchema>;

@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);
  private memoryChain?: Runnable<Record<string, string>, MemoryResult>;
  private taskChain?: Runnable<Record<string, string>, TaskResult>;

  constructor(
    private readonly semantic: SemanticMemory,
    private readonly tasks: TaskStore,
    private readonly metrics: MemoryMetricsService,
    private readonly employees: EmployeeRegistry,
    private readonly models: ChatModelFactory,
  ) {}

  /** "Dennis=dennis, Alex=alex" — so the model emits ids, not display names. */
  private peopleHint(id: Identity): string {
    const humans = id.participants.map((h) => `${titleCase(h)}=${h}`);
    const bots = this.employees.list().map((b) => `${b.name}=${b.id}`);
    return [...new Set([...humans, ...bots])].join(', ');
  }

  /** The real ids the model may name (present humans + roster bots), lowercased. */
  private knownIds(id: Identity): Set<string> {
    return new Set(
      [...id.participants, ...this.employees.list().map((b) => b.id)].map((s) =>
        s.toLowerCase(),
      ),
    );
  }

  /** Coerce a model-supplied id to a real one, or undefined — the model sometimes invents "<unknown>". */
  private realId(
    raw: string | undefined,
    known: Set<string>,
  ): string | undefined {
    const v = raw?.trim().toLowerCase();
    return v && known.has(v) ? v : undefined;
  }

  private memory() {
    return (this.memoryChain ??= RunnableSequence.from<
      Record<string, string>,
      MemoryResult
    >([
      RunnableLambda.from<Record<string, string>, HumanMessage[]>((v) => [
        new HumanMessage(MEMORY_PROMPT(v)),
      ]),
      this.models
        .buildExtractModel()
        .withStructuredOutput(MemorySchema, { name: 'reconcile_memory' }),
    ]).withConfig({ runName: 'Reconcile Memory' }));
  }

  private task() {
    return (this.taskChain ??= RunnableSequence.from<
      Record<string, string>,
      TaskResult
    >([
      RunnableLambda.from<Record<string, string>, HumanMessage[]>((v) => [
        new HumanMessage(TASK_PROMPT(v)),
      ]),
      this.models
        .buildExtractModel()
        .withStructuredOutput(TaskSchema, { name: 'reconcile_tasks' }),
    ]).withConfig({ runName: 'Reconcile Tasks' }));
  }

  /**
   * READ-ONLY suggestion pass. Reviews the turn and returns a short human-readable block
   * of memory suggestions (never writes to the store). The bot commits via its own
   * `remember` / `update_memory` / `forget` tools — the only write path.
   *
   * Returns '' when nothing qualifies (off-class turns: greetings, questions, task instructions,
   * coding-style, inferred preferences, status narration). Fire-and-forget (errors → '').
   */
  async reconcileMemory(
    bot: EmployeeDefinition,
    transcript: string,
    id: Identity,
    decision: Decision = 'respond',
  ): Promise<string> {
    try {
      // Show a wide slice of the accessible store so the model can detect contradictions and
      // suggest supersedes / updates against the correct #id.
      const current = await this.semantic.recall(
        transcript,
        id,
        RECONCILE_RECALL_LIMIT,
        RECONCILE_FLOOR,
      );
      const result = await this.memory().invoke({
        botName: bot.name,
        botRole: bot.role,
        room: id.isChannel
          ? `the team channel '${id.surface}'`
          : `a PRIVATE 1:1 DM with ${titleCase(id.speaker)}`,
        tierNote: id.isChannel
          ? ''
          : '\n  NOTE — this turn happened in a PRIVATE 1:1 DM: default to "private" for anything' +
            ' this person told you about themselves or in confidence; use project/team ONLY for' +
            ' clearly work-wide facts they would state openly in the team channel. For tier' +
            ` "project" you MUST also set "project" (your shared projects: ${recallProjects(id).join(', ') || '(none)'}).`,
        people: this.peopleHint(id),
        currentFacts: current.length
          ? current.map((f) => `- [#${f.id}] ${f.fact}`).join('\n')
          : '(none)',
        transcript,
      });
      const block = this.renderSuggestions(result);
      // Count suggestions by class — no write counters (writes go through agent tools + recordWrite).
      const corrections =
        result.add.filter((s) => s.kind === 'correction').length +
        result.update.filter((s) => s.kind === 'correction').length +
        result.delete.length;
      const decisions =
        result.add.filter((s) => s.kind === 'decision').length +
        result.update.filter((s) => s.kind === 'decision').length;
      const preferences =
        result.add.filter((s) => s.kind === 'preference').length +
        result.update.filter((s) => s.kind === 'preference').length;
      this.metrics.recordMemoryReconcile(decision, {
        corrections,
        decisions,
        preferences,
      });
      if (block) {
        this.logger.debug(
          `memory suggestions ${bot.name} [${decision}] corrections=${corrections} decisions=${decisions} preferences=${preferences}`,
        );
      }
      return block;
    } catch {
      /* fire-and-forget: reconciliation must never break a turn */
      return '';
    }
  }

  /**
   * Render the suggestion result into a short human-readable block, e.g.:
   *   • remember: "Dennis wants PRs to target develop, not main" (preference · team)
   *   • update_memory #12 → "Backend uses MySQL" (correction)
   *   • forget #7 (correction — contradicted)
   * Returns '' when the result has no suggestions.
   */
  private renderSuggestions(result: MemoryResult): string {
    const lines: string[] = [];
    for (const a of result.add) {
      if (!a.fact?.trim()) continue;
      const scope = a.tier !== 'project' ? ` · ${a.tier}` : '';
      lines.push(`• remember: "${a.fact}" (${a.kind}${scope})`);
    }
    for (const u of result.update) {
      if (!u.newFact?.trim()) continue;
      lines.push(`• update_memory #${u.id} → "${u.newFact}" (${u.kind})`);
    }
    for (const d of result.delete) {
      lines.push(`• forget #${d.id} (correction — contradicted)`);
    }
    return lines.join('\n');
  }

  /**
   * Reconcile THIS bot's reminders against the turn: capture new forward commitments, complete
   * finished ones, drop stale ones. Capture is SELF-OWNED for everyone but the team lead (each
   * bot reconciles every turn, so per-observer cross-owner capture would mint one copy per
   * watcher); the team lead sees and reconciles the whole team's plates. No process-wide lock:
   * open-dedup is enforced at the DB by the (project, owner, norm) unique index — exact-text only,
   * which is WHY paraphrased re-captures must be cut off at the prompt/ownership layer. complete/
   * drop act ONLY on reminders actually shown this turn. Fire-and-forget — errors swallowed.
   */
  async reconcileTasks(
    bot: EmployeeDefinition,
    transcript: string,
    id: Identity,
    decision: Decision = 'respond',
    /** Forwarded to the task chain so its LLM call nests under the turn's Langfuse trace. */
    config?: RunnableConfig,
  ): Promise<void> {
    try {
      // A DM spans every project the pair shares — its plate (and where complete/drop act) does too.
      // The team lead reconciles against the TEAM's open plates (mirroring fetch): he's the one
      // bot allowed to assign cross-owner, so he must see what already exists before adding, and
      // shownIds lets him clear teammates' stale items in the same pass.
      const projects = recallProjects(id);
      const open = (
        await Promise.all(
          projects.map((p) =>
            bot.teamLead
              ? this.tasks.openTasks(id.team, p)
              : this.tasks.remindersForBot(id.team, p, bot.id),
          ),
        )
      ).flat();
      const shownIds = new Set(open.map((t) => t.id));
      const projectById = new Map(open.map((t) => [t.id, t.project]));
      const result = await this.task().invoke(
        {
          botName: bot.name,
          room: id.isChannel
            ? `the team channel '${id.surface}'`
            : `a private 1:1 DM with ${titleCase(id.speaker)}`,
          projectNote: id.isChannel
            ? ''
            : `In this DM a reminder may belong to a specific project — for a new one, set "project" to one of:` +
              ` ${projects.join(', ')} (omit it for a general reminder).\n`,
          // Every bot reconciles every channel turn, so letting each capture a TEAMMATE's commitment
          // mints the same reminder once per observer. Non-lead bots capture their OWN commitments
          // only; the team lead is the one cross-owner assigner.
          ownershipNote: bot.teamLead
            ? `Set "owner" to whoever is responsible — you for your own commitments, or the teammate who committed or was handed the work. `
            : `Set "owner" ONLY to yourself (${bot.name}) — capture YOUR OWN commitments ("I'll …") and work handed TO YOU by name. A teammate's commitment is THEIRS to capture — never log a reminder for someone else. `,
          people: this.peopleHint(id),
          openTasks: open.length
            ? open
                .map(
                  (t) =>
                    `- [#${t.id}] ${t.description} (→ ${t.owner})${projects.length > 1 ? ` [${t.project}]` : ''}`,
                )
                .join('\n')
            : '(none)',
          transcript,
        },
        config,
      );
      const ids = this.knownIds(id);
      // Actual outcomes, not proposed lengths: addTask dedups to undefined on the unique index, and
      // complete/drop return false when the id isn't an open reminder this turn could act on.
      let added = 0;
      let completed = 0;
      let dropped = 0;
      for (const a of result.add) {
        if (a.description?.trim()) {
          const owner = this.realId(a.owner, ids) ?? bot.id; // default to the committing bot's own plate
          // The ownershipNote, enforced: a non-lead bot SKIPS (never rewrites onto its own plate)
          // a teammate-owned capture — six observers of one "I'll …" would otherwise mint six
          // copies the (project, owner, norm) index can't dedup. The owner reconciles their own
          // turn, so the commitment is still captured exactly once.
          if (!bot.teamLead && owner !== bot.id) continue;
          // A named project must be one this conversation may see; else the turn's home project.
          const named = a.project?.trim().toLowerCase();
          const t = await this.tasks.addTask({
            team: id.team,
            project: named && projects.includes(named) ? named : id.project,
            description: a.description,
            owner,
            createdBy: bot.id,
            source: id.surface,
          });
          if (t) added++;
        }
      }
      for (const c of result.complete) {
        if (
          shownIds.has(c.id) &&
          (await this.tasks.completeTask(
            id.team,
            projectById.get(c.id) ?? id.project,
            c.id,
          ))
        )
          completed++;
      }
      for (const d of result.drop) {
        if (
          shownIds.has(d.id) &&
          (await this.tasks.dropTask(
            id.team,
            projectById.get(d.id) ?? id.project,
            d.id,
          ))
        )
          dropped++;
      }
      this.metrics.recordTaskReconcile(decision, { added, completed, dropped });
      if (added || completed || dropped) {
        this.logger.debug(
          `reminders ${bot.name} [${decision}] +${added} ✓${completed} -${dropped}`,
        );
      }
    } catch {
      /* fire-and-forget */
    }
  }
}
