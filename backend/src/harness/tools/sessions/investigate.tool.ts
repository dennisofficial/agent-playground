import { z } from 'zod';
import type { Identity } from '../../domain/identity';
import {
  DEFAULT_INVESTIGATE_PROMPT,
  INVESTIGATE_INTENTS,
} from '../../engines/engine.prompts';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { WorktreeService } from '../../worktrees/worktree.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';
import { CreateSessionTool } from './session.tools';

const investigateSchema = z.object({
  question: z
    .string()
    .describe(
      'The code-grounded question to answer — be specific (e.g. "how does the conductor gate decide to respond?", "where is the board-claim race handled?", "does X already exist?").',
    ),
  intent: z
    .enum(INVESTIGATE_INTENTS)
    .optional()
    .describe(
      "Why you're investigating — sharpens what the worker focuses on. 'trace' = walk a known flow/path; 'debug' = chase unexpected behavior or check whether a premise is even true; 'review' = judge a design's trade-offs/risks. Omit if none fits.",
    ),
  worktreeId: z
    .string()
    .optional()
    .describe(
      'Which worktree to read in. Omit to use your latest worktree (or to auto-open a fresh one if you have none) — you rarely need to set this.',
    ),
});

/**
 * The fact-grounding tool — every employee has it. It's how an employee BACKS a fact or decision with
 * the real codebase instead of answering from memory: it opens a session in the `investigate` mode
 * (read-only at the engine seam, like plan, so it can never modify anything and needs no approval; but
 * WITHOUT the engine's native plan ceremony — the worker reads/greps and answers directly in one turn
 * instead of producing a plan artifact).
 *
 * It reuses `CreateSessionTool.openSession` (the shared worktree/ownership/ALS-detached path) on the
 * employee's INVESTIGATE engine recipe (execute's engine on a top-tier reasoning model — grounding
 * facts is worth the better model). The session stays open for read-only follow-ups (reply_session).
 * Like `create_session`, the answer relays back when the turn reports.
 */
@HarnessTool()
export class InvestigateTool implements IHarnessTool<typeof investigateSchema> {
  readonly name = 'investigate';
  readonly description =
    "Ground your answer in the ACTUAL codebase before you commit to it — spins up a read-only worker that reads/greps the real repo and reports what's actually true. Reach for it ANY time your reply, decision, or recommendation rests on a checkable fact about the code (how does X work, where is Y, does Z already exist, is this premise even true) and an open session or your memory doesn't already hold it: back it with the code instead of answering from memory or assumption. It never modifies anything and needs no approval. Put any brief first-person heads-up in THIS message's text; you're notified when it reports back, and it stays open for read-only follow-ups (reply_session).";
  readonly schema = investigateSchema;

  constructor(
    private readonly createSession: CreateSessionTool,
    private readonly worktrees: WorktreeService,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    { question, intent, worktreeId }: z.infer<typeof investigateSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const bot =
      this.employees.byId(id.selfAgent) ?? this.employees.fallbackOwner();
    // Investigate runs on the INVESTIGATE recipe (the session-runner resolves the mode to it); pin the
    // create-time engine to match so the per-turn spec's engine never disagrees. (Same engine as
    // execute — investigate is a model-only override — so this is just sourcing it from one builder.)
    const engine = bot.investigateEngine(this.employees.context()).engine;

    const wt = await this.resolveWorktree(id, worktreeId);
    if ('error' in wt) return wt.error;

    const opening = question.trim();
    // The shared investigate template adds the read-only/cite-file:line framing, the optional
    // intent emphasis, and the REQUIRED Confidence/Couldn't-verify trailer (see engine.prompts.ts).
    const openingTask = DEFAULT_INVESTIGATE_PROMPT({
      question: opening,
      intent,
    });
    const { sessionId } = await this.createSession.openSession({
      identity: id,
      worktreeId: wt.id,
      task: opening.slice(0, 80) || 'investigate',
      openingTask,
      mode: 'investigate',
      engine,
      parentChatTrace: ctx.parentChatTrace,
    });
    return `Investigating in ${wt.id}${wt.created ? ' (opened a fresh worktree)' : ''}: ${sessionId} (${engine}, read-only). You're notified when it reports back; close_session it once you have your answer.`;
  }

  /**
   * Resolve a worktree to read in: the given id, else the bot's latest, else auto-open a fresh one so
   * investigate "just works" (a read-only session still needs a checkout to read). Read-only, so it's
   * fine to reuse a worktree that has an execute session's in-progress changes — you're reading the
   * current state of the work.
   */
  private async resolveWorktree(
    id: Identity,
    worktreeId?: string,
  ): Promise<{ id: string; created?: boolean } | { error: string }> {
    if (worktreeId) {
      const wt = this.worktrees.get(worktreeId);
      return wt
        ? { id: wt.id }
        : {
            error: `No worktree "${worktreeId}" — check list_worktrees, or omit it to use your latest.`,
          };
    }
    const mine = this.worktrees.list({ ownerBot: id.selfAgent });
    const latest = mine[mine.length - 1];
    if (latest) return { id: latest.id };
    try {
      const { worktree } = await this.worktrees.create({
        name: 'investigate',
        ownerBot: id.selfAgent,
        team: id.team,
        project: id.project,
      });
      return { id: worktree.id, created: true };
    } catch (err) {
      return {
        error: `Couldn't open a worktree to investigate in: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
