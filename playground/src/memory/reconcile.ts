import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { z } from 'zod';
import { buildExtractModel } from '../model.js';
import { type Bot, ROSTER } from '../roster.js';
import { createMutex, rememberDeduped, withMemoryLock } from './dedup.js';
import { type Identity } from './identity.js';
import { forgetFact, recall, updateFact } from './semantic.js';
import { addTask, completeTask, dropTask, openTasks } from './tasks.js';

/**
 * The post-LLM RECONCILE — the write half of deterministic memory. After a bot's turn, two cheap Haiku
 * passes look at the turn + the CURRENT state and emit explicit ops: memory (add/update/delete) and tasks
 * (add/complete/drop). State-aware by design — they're shown what's already stored — so they reconcile ON
 * TOP of whatever the bot did with its own tools, and run on every gate path without minting duplicates.
 * Built in the project's `RunnableSequence + withStructuredOutput` style (same as gate.ts / fetch.ts).
 */

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
          tier: z.enum(['company', 'bot', 'private']),
          authorId: z.string().describe('id of the HUMAN who asserted it'),
        }),
      )
      .describe('NEW durable facts to remember; [] if none'),
    update: z
      .array(
        z.object({
          target: z.string().describe('roughly the existing fact to change'),
          newFact: z.string(),
        }),
      )
      .describe('existing facts that CHANGED; [] if none'),
    delete: z
      .array(
        z.object({
          target: z.string().describe('roughly the existing fact that is no longer true'),
        }),
      )
      .describe('facts contradicted/no longer true; [] if none'),
  });
  export type Result = z.infer<typeof Schema>;

  const PROMPT = `You are {botName}, the team's {botRole}, reconciling your MEMORY after a turn in the
#dev channel. People and their ids: {people}.

What you currently know (existing facts):
{currentFacts}

This turn:
{transcript}

Decide what should change (be conservative — most turns change nothing):
- add: NEW durable facts worth keeping long-term — a stable preference, decision, role, or company fact.
  ONLY from what the HUMANS said (not teammates' replies). NOT chatter, greetings, questions, task
  instructions, or coding-style. Set "tier" (company = default for work facts + the boss's prefs; private
  = personal/sensitive; bot = only you) and "authorId" = the human who said it. Do NOT re-add something
  already in the existing facts above — even if it's worded differently or is a paraphrase of one.
- update: an existing fact that CHANGED — give "target" (roughly the old fact) and "newFact".
- delete: an existing fact now contradicted or no longer true — give "target".

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
export async function reconcileMemory(bot: Bot, transcript: string, id: Identity): Promise<void> {
  try {
    const current = await recall(transcript, id, 10);
    const result = await MemoryReconcile.get().invoke({
      botName: bot.name,
      botRole: bot.role,
      people: peopleHint(id),
      currentFacts: current.length ? current.map((f) => `- ${f.fact}`).join('\n') : '(none)',
      transcript,
    });
    // Write-application: each mutation is serialized (rememberDeduped locks internally; update/delete
    // wrap withMemoryLock) so concurrent bots reconciling the same turn dedup against each other's
    // writes instead of racing. The model.invoke above stays OUTSIDE the lock — only the writes need it.
    const ids = knownIds(id);
    for (const a of result.add) {
      if (!a.fact?.trim()) continue;
      const speaker = realId(a.authorId, ids) ?? id.speaker;
      await rememberDeduped({ fact: a.fact, tier: a.tier, id: { ...id, speaker } });
    }
    for (const u of result.update) {
      if (u.target?.trim() && u.newFact?.trim())
        await withMemoryLock(() => updateFact(u.target, u.newFact, id));
    }
    for (const d of result.delete) {
      if (d.target?.trim()) await withMemoryLock(() => forgetFact(d.target, id));
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
    reasoning: z.string().describe('one short sentence on what changed on the board, if anything'),
    add: z
      .array(
        z.object({
          description: z.string(),
          assignee: z.string().optional().describe('id, if clear'),
        }),
      )
      .describe('NEW open tasks/handoffs not already on the board; [] if none'),
    complete: z
      .array(z.object({ id: z.number() }))
      .describe('open tasks that just got DONE (by #id); [] if none'),
    drop: z
      .array(z.object({ id: z.number() }))
      .describe('open tasks no longer relevant (by #id); [] if none'),
  });
  export type Result = z.infer<typeof Schema>;

  const PROMPT = `You are {botName}, reconciling the team's TASK BOARD after a turn in the #dev channel.
People and their ids: {people}.

Open tasks right now (with #ids):
{openTasks}

This turn:
{transcript}

Decide (be conservative):
- add: a NEW concrete open task or handoff that someone needs to follow up on ("you'll wire the hooks
  once the API's up", "I'll send you the spec"). Set "assignee" id when clear. Do NOT add something that
  is ALREADY on the board above — even if worded differently.
- complete: an open task (by #id) that this turn shows is now DONE.
- drop: an open task (by #id) that's no longer relevant.

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

// Process-wide async mutex serializing task reconciliation, so two bots can't both read an empty board
// and emit the same handoff — the second runs after the first's write and the state-aware model dedups
// it. (A sibling of withMemoryLock; both come from the shared createMutex helper in dedup.ts.)
const withTaskLock = createMutex();

/**
 * Reconcile the task board against the turn: add new handoffs, complete finished ones, drop stale ones.
 * Serialized across bots (read-board → model → write all under `withTaskLock`) so always-run can't mint
 * duplicates. Fire-and-forget — errors swallowed.
 */
export async function reconcileTasks(bot: Bot, transcript: string, id: Identity): Promise<void> {
  await withTaskLock(async () => {
    try {
      const open = openTasks(id.company);
      const result = await TaskReconcile.get().invoke({
        botName: bot.name,
        people: peopleHint(id),
        openTasks: open.length
          ? open
              .map((t) => `- [#${t.id}] ${t.description}${t.assignee ? ` (→ ${t.assignee})` : ''}`)
              .join('\n')
          : '(none)',
        transcript,
      });
      const ids = knownIds(id);
      for (const a of result.add) {
        if (a.description?.trim())
          addTask({
            company: id.company,
            description: a.description,
            assignee: realId(a.assignee, ids),
            createdBy: bot.id,
            source: id.surface,
          });
      }
      for (const c of result.complete) if (typeof c.id === 'number') completeTask(id.company, c.id);
      for (const d of result.drop) if (typeof d.id === 'number') dropTask(id.company, d.id);
      if (result.add.length || result.complete.length || result.drop.length) {
        process.stderr.write(
          `[reconcile:${bot.name}] tasks +${result.add.length} ✓${result.complete.length} -${result.drop.length}\n`,
        );
      }
    } catch {
      /* fire-and-forget */
    }
  });
}
