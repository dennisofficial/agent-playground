import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { z } from 'zod';
import { type Employee, ROSTER } from '../employees/index.js';
import { buildExtractModel } from '../model.js';
import { rememberDeduped, withMemoryLock } from './dedup.js';
import { type Identity } from './identity.js';
import { forgetFactById, recall, updateFactById } from './semantic.js';
import { addTask, completeTask, dropTask, remindersForBot } from './tasks.js';

/**
 * The post-LLM RECONCILE — the write half of deterministic memory. After a bot's turn, two cheap Haiku
 * passes look at the turn + the CURRENT state and emit explicit ops: memory (add/update/delete) and tasks
 * (add/complete/drop). State-aware by design — they're shown what's already stored — so they reconcile ON
 * TOP of whatever the bot did with its own tools, and run on every gate path without minting duplicates.
 * Built in the project's `RunnableSequence + withStructuredOutput` style (same as gate.ts / fetch.ts).
 */

// How many accessible facts to show the memory-reconcile model as "what you currently know". Wider than
// the recall-tool default so the dedup/supersede judgment sees most of the relevant store, not a top-few.
const RECONCILE_RECALL_LIMIT = 25;
// Reconcile uses a LOWER recall floor than fetch: fetch wants to suppress junk (MIN_RECALL_SIM), but
// reconcile wants to SEE marginal neighbors so it can spot a fact this turn contradicts/supersedes — a
// floor too high here means it never sees the old fact and re-accumulates the contradiction. (Tune with
// MIN_RECALL_SIM against real text-embedding-3-small cosines, which run low — see memory-scope-model.)
const RECONCILE_FLOOR = 0.15;

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "Dennis=dennis, Alex=alex, James=james" — so the model emits ids, not display names. */
function peopleHint(id: Identity): string {
  const humans = id.participants.map((h) => `${titleCase(h)}=${h}`);
  const bots = ROSTER.map((b) => `${b.name}=${b.id}`);
  return [...new Set([...humans, ...bots])].join(', ');
}

/** The real ids the model may name (present humans + roster bots), lowercased. */
const knownIds = (id: Identity): Set<string> =>
  new Set([...id.participants, ...ROSTER.map((b) => b.id)].map((s) => s.toLowerCase()));

/** Coerce a model-supplied id to a real one, or undefined — the model sometimes invents "<unknown>". */
const realId = (raw: string | undefined, known: Set<string>): string | undefined => {
  const v = raw?.trim().toLowerCase();
  return v && known.has(v) ? v : undefined;
};

// ── Memory reconcile ───────────────────────────────────────────────────────────────────────────────

namespace MemoryReconcile {
  const Schema = z.object({
    reasoning: z.string().describe('one short sentence on what changed in memory, if anything'),
    add: z
      .array(
        z.object({
          fact: z.string(),
          tier: z.enum(['team', 'project', 'bot', 'private']),
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
            .describe('the #id of the existing fact (from the list above) that changed'),
          newFact: z.string(),
        }),
      )
      .describe('existing facts (by #id) that CHANGED; [] if none'),
    delete: z
      .array(
        z.object({
          id: z.number().describe('the #id of the existing fact (from the list above) to remove'),
        }),
      )
      .describe('existing facts (by #id) contradicted/no longer true; [] if none'),
  });
  export type Result = z.infer<typeof Schema>;

  const PROMPT = `You are {botName}, the team's {botRole}, reconciling your MEMORY after a turn in the
#dev channel. People and their ids: {people}.

What you currently know (existing facts, each with its #id):
{currentFacts}

This turn:
{transcript}

Decide what should change (be conservative — most turns change nothing). Reference existing facts ONLY
by the #id shown above — never invent an id:
- add: NEW durable facts worth keeping long-term — a stable preference, decision, role, or project fact.
  ONLY from what the HUMANS said (not teammates' replies). NOT chatter, greetings, questions, task
  instructions, or coding-style. Set "tier": project = DEFAULT for work facts (about THIS project — its
  repo, stack, goals, or a decision made here); team = roles, who does what, and the boss's STANDING
  preferences that hold across every project; private = personal/sensitive; bot = only you. Set "authorId"
  = the human who said it. Do NOT re-add something already above — even if worded differently. If the new
  fact CONTRADICTS or replaces an existing one, set "supersedes" to that fact's #id (so the stale one is
  overwritten, not kept alongside it).
- update: an existing fact (by #id) whose wording/value CHANGED — give "id" and "newFact".
- delete: an existing fact (by #id) now contradicted or no longer true — give "id".

Return empty arrays when nothing changed.`;

  let chain: ReturnType<typeof build> | undefined;
  export const get = () => (chain ??= build());
  const build = () =>
    RunnableSequence.from<Record<string, string>, Result>([
      new PromptTemplate({
        template: PROMPT,
        inputVariables: ['botName', 'botRole', 'people', 'currentFacts', 'transcript'],
      }),
      buildExtractModel().withStructuredOutput(Schema, { name: 'reconcile_memory' }),
    ]).withConfig({ runName: 'Reconcile Memory' });
}

/**
 * Reconcile this bot's memory against the turn: add new facts, update changed ones, delete contradicted
 * ones. Concurrent across bots — `remember` dedups-on-upsert by cosine, so parallel adds merge. Per-fact
 * identity (speaker = the asserting human). Fire-and-forget — errors swallowed.
 */
export async function reconcileMemory(
  bot: Employee,
  transcript: string,
  id: Identity,
): Promise<void> {
  try {
    // Show a wider slice of the accessible store (was 10) so the model's "is this a duplicate / does this
    // supersede something" judgment isn't blind to most of memory. recall's relevance floor keeps it to
    // facts actually related to this turn.
    const current = await recall(transcript, id, RECONCILE_RECALL_LIMIT, RECONCILE_FLOOR);
    const shownIds = new Set(current.map((f) => f.id));
    const result = await MemoryReconcile.get().invoke({
      botName: bot.name,
      botRole: bot.role,
      people: peopleHint(id),
      currentFacts: current.length
        ? current.map((f) => `- [#${f.id}] ${f.fact}`).join('\n')
        : '(none)',
      transcript,
    });
    // Write-application: each mutation is serialized (rememberDeduped locks internally; update/delete
    // wrap withMemoryLock) so concurrent bots reconciling the same turn dedup against each other's
    // writes instead of racing. The model.invoke above stays OUTSIDE the lock — only the writes need it.
    // update/delete/supersede act ONLY on ids actually shown to the model this turn (no clobbering a fact
    // it never saw); updateFactById additionally scope-checks each id as defense in depth.
    const ids = knownIds(id);
    for (const a of result.add) {
      if (!a.fact?.trim()) continue;
      // A contradicting/replacing add overwrites the named fact in place instead of co-storing the
      // opposite (the dedup judge treats opposites as distinct, so a plain add would keep both).
      if (typeof a.supersedes === 'number' && shownIds.has(a.supersedes)) {
        await withMemoryLock(() => updateFactById(a.supersedes as number, a.fact, id));
        continue;
      }
      const speaker = realId(a.authorId, ids) ?? id.speaker;
      await rememberDeduped({ fact: a.fact, tier: a.tier, id: { ...id, speaker } });
    }
    for (const u of result.update) {
      if (shownIds.has(u.id) && u.newFact?.trim())
        await withMemoryLock(() => updateFactById(u.id, u.newFact, id));
    }
    for (const d of result.delete) {
      if (shownIds.has(d.id)) await withMemoryLock(async () => forgetFactById(d.id, id));
    }
    if (result.add.length || result.update.length || result.delete.length) {
      process.stderr.write(
        `[reconcile:${bot.name}] memory +${result.add.length} ~${result.update.length} -${result.delete.length}\n`,
      );
    }
  } catch {
    /* fire-and-forget: reconciliation must never break a turn */
  }
}

// ── Task reconcile (serialized) ──────────────────────────────────────────────────────────────────────

namespace TaskReconcile {
  const Schema = z.object({
    reasoning: z.string().describe('one short sentence on what changed on the plates, if anything'),
    add: z
      .array(
        z.object({
          description: z.string(),
          owner: z
            .string()
            .describe(
              'id of who is RESPONSIBLE — the teammate who committed ("I\'ll…" → themselves) or who it was handed to',
            ),
        }),
      )
      .describe(
        'NEW commitments to future work made THIS turn, especially DEFERRED ones ("after I finish X", "later", "once Y is up"); [] if none',
      ),
    complete: z
      .array(z.object({ id: z.number() }))
      .describe('open reminders (by #id above) this turn shows are now DONE; [] if none'),
    drop: z
      .array(z.object({ id: z.number() }))
      .describe('open reminders (by #id above) no longer relevant; [] if none'),
  });
  export type Result = z.infer<typeof Schema>;

  const PROMPT = `You are {botName}, keeping the team's personal REMINDERS straight after a turn in the
#dev channel. People and their ids: {people}.

Open reminders right now (with #ids — yours, and ones you raised for others):
{openTasks}

This turn:
{transcript}

A reminder is a concrete commitment to FUTURE work, captured so it isn't lost in a long, summarized work
session — ESPECIALLY a deferred one ("got it, I'll do that after I finish this", "I'll send the spec
later", "once the API's up I'll wire the hooks"). Decide (be conservative — most turns add nothing):
- add: a NEW such commitment made THIS turn. Set "owner" to whoever is responsible — {botName} for "I'll
  …", or the named teammate for a handoff ("Riley, you'll wire the UI" → owner riley). Do NOT re-add work
  already a reminder above, and do NOT capture chit-chat, finished replies, or vague non-commitments.
- complete: an open reminder (by #id above) this turn shows is finished.
- drop: an open reminder (by #id above) no longer relevant.

Return empty arrays when nothing changed.`;

  let chain: ReturnType<typeof build> | undefined;
  export const get = () => (chain ??= build());
  const build = () =>
    RunnableSequence.from<Record<string, string>, Result>([
      new PromptTemplate({
        template: PROMPT,
        inputVariables: ['botName', 'people', 'openTasks', 'transcript'],
      }),
      buildExtractModel().withStructuredOutput(Schema, { name: 'reconcile_tasks' }),
    ]).withConfig({ runName: 'Reconcile Tasks' });
}

/**
 * Reconcile THIS bot's reminders against the turn: capture new forward commitments (esp. deferred ones)
 * onto the responsible person's plate, complete finished ones, drop stale ones. Runs per-bot (each owns
 * its own plate + the handoffs it raised). No process-wide lock: open-dedup is enforced at the DB by the
 * per (project, owner, norm) unique index, so concurrent bots reflecting on the same handoff can't double-
 * insert. complete/drop act ONLY on reminders actually shown this turn (no closing one it never saw).
 * Fire-and-forget — errors swallowed.
 */
export async function reconcileTasks(
  bot: Employee,
  transcript: string,
  id: Identity,
): Promise<void> {
  try {
    const open = remindersForBot(id.project, bot.id);
    const shownIds = new Set(open.map((t) => t.id));
    const result = await TaskReconcile.get().invoke({
      botName: bot.name,
      people: peopleHint(id),
      openTasks: open.length
        ? open.map((t) => `- [#${t.id}] ${t.description} (→ ${t.owner})`).join('\n')
        : '(none)',
      transcript,
    });
    const ids = knownIds(id);
    for (const a of result.add) {
      if (a.description?.trim())
        addTask({
          project: id.project,
          description: a.description,
          owner: realId(a.owner, ids) ?? bot.id, // default to the committing bot's own plate
          createdBy: bot.id,
          source: id.surface,
        });
    }
    for (const c of result.complete) if (shownIds.has(c.id)) completeTask(id.project, c.id);
    for (const d of result.drop) if (shownIds.has(d.id)) dropTask(id.project, d.id);
    if (result.add.length || result.complete.length || result.drop.length) {
      process.stderr.write(
        `[reconcile:${bot.name}] reminders +${result.add.length} ✓${result.complete.length} -${result.drop.length}\n`,
      );
    }
  } catch {
    /* fire-and-forget */
  }
}
