import { Inject } from '@nestjs/common';
import { z } from 'zod';
import type { Identity } from '../../domain/identity';
import {
  DEFAULT_INVESTIGATE_PROMPT,
  INVESTIGATE_INTENTS,
} from '../../engines/engine.prompts';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { ProjectStore } from '../../projects/project-store';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../../sessions/session-registry.port';
import { WorktreeService } from '../../worktrees/worktree.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';
import { CreateSessionTool } from './session.tools';

const GITHUB_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+?(\.git)?$/;

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
  board_task_id: z
    .number()
    .int()
    .optional()
    .describe(
      "The board task this read grounds (#N) — set it when you're grounding a feature's section breakdown so the decomposition traces to a real code read (the dispatch guard looks for an investigate tied to the task).",
    ),
  references: z
    .array(z.string())
    .optional()
    .describe(
      'Other projects to also read read-only for grounding — catalog ids/names (e.g. "cubix-infra") or GitHub URLs. Each is cloned read-only and the worker can read it ALONGSIDE the main repo (e.g. "how does cubix-infra do SSE?"). Unresolved names come back with a Remedy.',
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
    private readonly projects: ProjectStore,
    @Inject(SESSION_REGISTRY)
    private readonly sessions: SessionRegistry,
  ) {}

  async execute(
    { question, intent, worktreeId, board_task_id, references }: z.infer<
      typeof investigateSchema
    >,
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

    // Materialize any reference repos read-only so the worker can read them alongside the main repo.
    const refs = await this.resolveReferences(id.team, references ?? []);

    const opening = question.trim();
    // The shared investigate template adds the read-only/cite-file:line framing, the optional
    // intent emphasis, and the REQUIRED Confidence/Couldn't-verify trailer (see engine.prompts.ts).
    const refBlock = refs.resolved.length
      ? `\n\nReference repos you may ALSO read (read-only, paths outside the main worktree):\n${refs.resolved
          .map((r) => `- ${r.label} at ${r.path}`)
          .join('\n')}`
      : '';
    const openingTask =
      DEFAULT_INVESTIGATE_PROMPT({ question: opening, intent }) + refBlock;
    const { sessionId } = await this.createSession.openSession({
      identity: id,
      worktreeId: wt.id,
      task: opening.slice(0, 80) || 'investigate',
      openingTask,
      mode: 'investigate',
      engine,
      boardTaskId: board_task_id,
      parentChatTrace: ctx.parentChatTrace,
    });
    // Record the attached references on the session (durable read set — the v2 container-mount seam).
    if (refs.resolved.length)
      await this.sessions
        .update(sessionId, {
          referencedProjects: refs.resolved.map((r) => ({
            ...(r.projectId ? { projectId: r.projectId } : {}),
            gitUrl: r.gitUrl,
            path: r.path,
            mode: 'read' as const,
          })),
        })
        .catch(() => undefined);

    const refNote = refs.resolved.length
      ? ` Reading also: ${refs.resolved.map((r) => r.label).join(', ')}.`
      : '';
    const missingNote = refs.missing.length
      ? `\nRemedy: couldn't resolve ${refs.missing.join(', ')} — onboard_project them (or check the name) if they should be readable, then re-run.`
      : '';
    return `Investigating in ${wt.id}${wt.created ? ' (opened a fresh worktree)' : ''}: ${sessionId} (${engine}, read-only).${refNote} You're notified when it reports back; close_session it once you have your answer.${missingNote}`;
  }

  /**
   * Resolve reference names/URLs to read-only clones. A catalog name → the registered project's
   * clone; a GitHub URL → a one-off clone with the default token. Unresolved names are collected
   * (returned as a Remedy) rather than failing the whole investigation.
   */
  private async resolveReferences(
    team: string,
    names: string[],
  ): Promise<{
    resolved: {
      label: string;
      path: string;
      projectId?: string;
      gitUrl: string;
    }[];
    missing: string[];
  }> {
    const resolved: {
      label: string;
      path: string;
      projectId?: string;
      gitUrl: string;
    }[] = [];
    const missing: string[] = [];
    if (names.length === 0) return { resolved, missing };
    const catalog = await this.projects.list(team).catch(() => []);
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      try {
        if (GITHUB_URL.test(name)) {
          const r = await this.worktrees.ensureReferenceClone(team, {
            gitUrl: name,
          });
          resolved.push({ label: name, path: r.path, gitUrl: r.gitUrl });
        } else {
          const rec = catalog.find(
            (p) =>
              p.projectId.toLowerCase() === name.toLowerCase() ||
              p.displayName.toLowerCase() === name.toLowerCase(),
          );
          if (!rec) {
            missing.push(name);
            continue;
          }
          const r = await this.worktrees.ensureReferenceClone(team, {
            projectId: rec.projectId,
          });
          resolved.push({
            label: rec.projectId,
            path: r.path,
            projectId: rec.projectId,
            gitUrl: r.gitUrl,
          });
        }
      } catch {
        missing.push(name);
      }
    }
    return { resolved, missing };
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
