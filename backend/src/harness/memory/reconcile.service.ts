import { PromptTemplate } from '@langchain/core/prompts';
import {
  Runnable,
  type RunnableConfig,
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
import { MemoryWriteService } from './memory-write.service';
import { SemanticMemory } from './semantic-memory';
import { TaskStore } from './task-store';

/**
 * The post-LLM RECONCILE — the write half of deterministic memory. After a bot's turn, two cheap
 * Haiku passes look at the turn + the CURRENT state and emit explicit ops: memory (add/update/
 * delete) and tasks (add/complete/drop). State-aware by design — they're shown what's already
 * stored — so they reconcile ON TOP of whatever the bot did with its own tools, and run on every
 * gate path without minting duplicates.
 * (Ported from playground/src/memory/reconcile.ts; logBus debug rows became Logger lines.)
 */

// How many accessible facts to show the memory-reconcile model as "what you currently know". Wider
// than the recall-tool default so the dedup/supersede judgment sees most of the relevant store.
const RECONCILE_RECALL_LIMIT = 25;
// Reconcile uses a LOWER recall floor than fetch: fetch suppresses junk (MIN_RECALL_SIM), but
// reconcile wants to SEE marginal neighbors so it can spot a fact this turn contradicts/supersedes.
const RECONCILE_FLOOR = 0.15;

const MemorySchema = z.object({
  reasoning: z
    .string()
    .describe('one short sentence on what changed in memory, if anything'),
  add: z
    .array(
      z.object({
        fact: z.string(),
        tier: z.enum(['team', 'project', 'bot', 'private']),
        project: z
          .string()
          .optional()
          .describe(
            'ONLY for tier "project" in a DM: which project the fact belongs to (one of the projects listed in the note). A DM is not bound to a project; an un-named or unknown project keeps the fact private to the pair.',
          ),
        authorId: z.string().describe('id of the HUMAN who asserted it'),
        supersedes: z
          .number()
          .optional()
          .describe(
            'the #id of an existing fact this one CONTRADICTS or replaces (e.g. "we use MySQL now" vs an existing "we use Postgres") — set it so the old fact is overwritten, not kept alongside. Omit for a genuinely new fact.',
          ),
      }),
    )
    .describe('NEW durable facts to remember; [] if none'),
  update: z
    .array(
      z.object({
        id: z
          .number()
          .describe(
            'the #id of the existing fact (from the list above) that changed',
          ),
        newFact: z
          .string()
          .describe(
            'the corrected fact, stated minimally — one bare atomic claim, no elaboration',
          ),
      }),
    )
    .describe('existing facts (by #id) that CHANGED; [] if none'),
  delete: z
    .array(
      z.object({
        id: z
          .number()
          .describe(
            'the #id of the existing fact (from the list above) to remove',
          ),
      }),
    )
    .describe(
      'existing facts (by #id) contradicted/no longer true; [] if none',
    ),
});
type MemoryResult = z.infer<typeof MemorySchema>;

const MEMORY_PROMPT = `You are {botName}, the team's {botRole}, reconciling your MEMORY after a turn in
{room}. People and their ids: {people}.

What you currently know (existing facts, each with its #id):
{currentFacts}

This turn:
{transcript}

Decide what should change (be conservative — most turns change nothing). Reference existing facts ONLY
by the #id shown above — never invent an id:
- add: NEW durable facts worth keeping long-term — a stable preference, decision, role, or project fact.
  ONLY from what the HUMANS said (not teammates' replies). NOT chatter, greetings, questions, task
  instructions, or coding-style. State each as the BARE atomic claim ONLY — the decision/preference
  itself, with no interpretation, consequences, rationale, or "what this means for X" elaboration (store
  "Backend standardizes on PostgreSQL", NOT a paragraph about migrations and future work); elaborated
  facts pile up as near-duplicates that never dedup. Set "tier": project = DEFAULT for work facts (about THIS project — its
  repo, stack, goals, or a decision made here); team = roles, who does what, and the boss's STANDING
  preferences that hold across every project; private = personal/sensitive; bot = only you. Set "authorId"
  = the human who said it. Do NOT re-add something already above — even if worded differently. If the new
  fact CONTRADICTS or replaces an existing one, set "supersedes" to that fact's #id (so the stale one is
  overwritten, not kept alongside it).{tierNote}
- update: an existing fact (by #id) whose wording/value CHANGED — give "id" and "newFact".
- delete: an existing fact (by #id) now contradicted or no longer true — give "id".

Return empty arrays when nothing changed.`;

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

const TASK_PROMPT = `You are {botName}, keeping the team's personal REMINDERS straight after a turn in
{room}. People and their ids: {people}.

Open reminders right now (with #ids — yours, and ones you raised for others):
{openTasks}

This turn:
{transcript}

A reminder is a concrete commitment to FUTURE work, captured so it isn't lost in a long, summarized work
session — ESPECIALLY a deferred one ("got it, I'll do that after I finish this", "I'll send the spec
later", "once the API's up I'll wire the hooks"). Decide (be conservative — most turns add nothing):
{projectNote}- add: a NEW such commitment made THIS turn. {ownershipNote}Do NOT re-add work already a reminder
  above — even reworded; one open reminder per piece of work, never a second copy. Do NOT capture status
  narration about work already underway ("publishing now", "still running", "I'll push once X lands" about
  an effort already in motion) — a reminder is for work that would otherwise be FORGOTTEN, not a play-by-play.
  Do NOT capture anything this same turn also reports finished, and NOT chit-chat, finished replies, or
  vague non-commitments.
- complete: an open reminder (by #id above) this turn shows is finished.
- drop: an open reminder (by #id above) no longer relevant.

Return empty arrays when nothing changed.`;

@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);
  private memoryChain?: Runnable<Record<string, string>, MemoryResult>;
  private taskChain?: Runnable<Record<string, string>, TaskResult>;

  constructor(
    private readonly semantic: SemanticMemory,
    private readonly tasks: TaskStore,
    private readonly writes: MemoryWriteService,
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
      new PromptTemplate({
        template: MEMORY_PROMPT,
        inputVariables: [
          'botName',
          'botRole',
          'room',
          'tierNote',
          'people',
          'currentFacts',
          'transcript',
        ],
      }),
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
      new PromptTemplate({
        template: TASK_PROMPT,
        inputVariables: [
          'botName',
          'room',
          'projectNote',
          'ownershipNote',
          'people',
          'openTasks',
          'transcript',
        ],
      }),
      this.models
        .buildExtractModel()
        .withStructuredOutput(TaskSchema, { name: 'reconcile_tasks' }),
    ]).withConfig({ runName: 'Reconcile Tasks' }));
  }

  /**
   * Reconcile this bot's memory against the turn: add new facts, update changed ones, delete
   * contradicted ones. Concurrent across bots — writes serialize through MemoryWriteService.
   * Fire-and-forget — errors swallowed (reconciliation must never break a turn).
   */
  async reconcileMemory(
    bot: EmployeeDefinition,
    transcript: string,
    id: Identity,
    decision: Decision = 'respond',
  ): Promise<void> {
    try {
      // Show a wide slice of the accessible store so the "is this a duplicate / does this supersede
      // something" judgment isn't blind to most of memory.
      const current = await this.semantic.recall(
        transcript,
        id,
        RECONCILE_RECALL_LIMIT,
        RECONCILE_FLOOR,
      );
      const shownIds = new Set(current.map((f) => f.id));
      const result = await this.memory().invoke({
        botName: bot.name,
        botRole: bot.role,
        room: id.isChannel
          ? `the team channel '${id.surface}'`
          : `a PRIVATE 1:1 DM with ${titleCase(id.speaker)}`,
        // The write-side leak guard, mirrored into the reconcile pass: DM confidences default to the
        // pair tier so they never surface in group chat. A DM is project-less — a project fact
        // there must NAME one of the projects this pair shares.
        tierNote: id.isChannel
          ? ''
          : '\n  NOTE — this turn happened in a PRIVATE 1:1 DM: default to "private" for anything this person told' +
            ' you about themselves or in confidence; use project/team ONLY for clearly work-wide facts they would' +
            ' state openly in the team channel. A DM is not tied to one project — for tier "project" you MUST' +
            ` also set "project" to the project the fact is about (your shared projects: ${recallProjects(id).join(', ') || '(none)'});` +
            ' without it the fact stays private to the two of you.',
        people: this.peopleHint(id),
        currentFacts: current.length
          ? current.map((f) => `- [#${f.id}] ${f.fact}`).join('\n')
          : '(none)',
        transcript,
      });
      // Write-application: each mutation is serialized; the model.invoke above stays OUTSIDE the
      // lock. update/delete/supersede act ONLY on ids actually shown to the model this turn;
      // updateFactById additionally scope-checks each id as defense in depth. Tally what ACTUALLY
      // landed (an add can dedup-merge; an update/delete no-ops when its id isn't live/accessible).
      const ids = this.knownIds(id);
      let inserted = 0;
      let deduped = 0;
      let updated = 0;
      let deleted = 0;
      for (const a of result.add) {
        if (!a.fact?.trim()) continue;
        // A contradicting/replacing add overwrites the named fact in place instead of co-storing the
        // opposite (the dedup judge treats opposites as distinct, so a plain add would keep both).
        if (typeof a.supersedes === 'number' && shownIds.has(a.supersedes)) {
          const r = await this.writes.withLock(() =>
            this.semantic.updateFactById(a.supersedes as number, a.fact, id),
          );
          if (r) updated++;
          continue;
        }
        const speaker = this.realId(a.authorId, ids) ?? id.speaker;
        const r = await this.writes.rememberDeduped({
          fact: a.fact,
          tier: a.tier,
          id: { ...id, speaker },
          project: a.project,
        });
        if (r.action === 'inserted') inserted++;
        else deduped++;
      }
      for (const u of result.update) {
        if (shownIds.has(u.id) && u.newFact?.trim()) {
          const r = await this.writes.withLock(() =>
            this.semantic.updateFactById(u.id, u.newFact, id),
          );
          if (r) updated++;
        }
      }
      for (const d of result.delete) {
        if (shownIds.has(d.id)) {
          const r = await this.writes.withLock(() =>
            this.semantic.forgetFactById(d.id, id),
          );
          if (r) deleted++;
        }
      }
      // Record EVERY pass (even all-zero) so ignore/acknowledge attempts form the denominator for
      // "do silent reconciles ever write?" The debug line fires only when something changed.
      this.metrics.recordMemoryReconcile(decision, {
        inserted,
        deduped,
        updated,
        deleted,
      });
      if (inserted || deduped || updated || deleted) {
        this.logger.debug(
          `memory ${bot.name} [${decision}] +${inserted} ≈${deduped} ✎${updated} -${deleted}`,
        );
      }
    } catch {
      /* fire-and-forget: reconciliation must never break a turn */
    }
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
      const result = await this.task().invoke({
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
      }, config);
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
