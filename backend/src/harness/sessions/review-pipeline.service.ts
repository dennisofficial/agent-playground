import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EmployeeContext } from '../employees/employee-context';
import type { EmployeeDefinition } from '../employees/employee.types';
import { EmployeeRegistry } from '../employees/employee.registry';
import { SELF_REVIEW } from '../employees/capabilities/self-review.capability';
import type { EngineSpec } from '../engines/engine-spec';
import { EngineRegistry } from '../engines/engine.registry';
import { withActiveRoot } from '../engines/guard';
import {
  EWorkerEngineName,
  type WorkerEvent,
} from '../engines/worker-engine.port';
import { CredentialContext } from '../llm-keys/credential-context';
import {
  TenantCredentialService,
  type TenantKeys,
} from '../llm-keys/tenant-credential.service';
import { BoardStore } from '../memory/board-store';
import { BoardEventsBus } from '../memory/board-events.bus';
import { PlanStore, type TaskPlan } from '../memory/plan-store';
import { parseGithubRepo } from '../projects/git-auth';
import { GithubApiService } from '../projects/github-api.service';
import { GithubTokenStore } from '../projects/github-token-store';
import { WorktreeService } from '../worktrees/worktree.service';
import {
  CODE_REVIEW_PROMPT,
  CONFLICT_RESOLVE_PROMPT,
  INTEGRATION_REVIEW_PROMPT,
  REVIEW_FIX_PROMPT,
  parseVerdict,
} from './review-pipeline.prompts';
import {
  SESSION_REGISTRY,
  type Session,
  type SessionRegistry,
} from './session-registry.port';
import { SessionRunnerService } from './session-runner.service';

/** How many fix passes the per-owner review loop runs before handing back to the human. */
const MAX_FIX_PASSES = 2;
/** Bound on a single internal fix/resolve turn so a stuck engine can't hang the pipeline. */
const INTERNAL_TURN_TIMEOUT_MS = 15 * 60 * 1000;

export type OwnerReviewOutcome =
  | { kind: 'complete' }
  | { kind: 'blocked'; reason: string };

/**
 * The harness-driven PR self-review pipeline — the built-in replacement for the prose instruction
 * Sam kept forgetting ("self-review the PR, then mark it ready"). It runs as a SessionsModule service
 * (it already has the engines, credentials, worktree and session runner it needs; ProjectsModule adds
 * the GitHub client) and is invoked by the `submit_for_review` tool.
 *
 * Two entry points:
 *  - reviewOwner(session): per-owner. Reviews ONLY this owner's diff (cross-engine, read-only), runs a
 *    bounded in-session fix loop, publishes the owner's branch onto the shared branch, and marks the
 *    owner's plan row 'complete'. A publish conflict or an exhausted fix loop marks the row 'blocked'
 *    and seeds the owner to recover — it NEVER completes on failure.
 *  - integrate(team, taskId): the task-level barrier, fired only when the LAST owner completes. Opens
 *    the shared-branch DRAFT PR, runs a final integration review, and on a clean verdict flips the PR
 *    to ready and the ticket to 'in_review'.
 *
 * Every milestone emits a board event so the conductor wakes the owner to narrate it in their own
 * voice (Dennis's choice). The bot reaches a 'self_review' session only through the runner's internal
 * resume path — never a tool call.
 */
@Injectable()
export class ReviewPipelineService {
  private readonly logger = new Logger(ReviewPipelineService.name);

  constructor(
    private readonly engines: EngineRegistry,
    private readonly employees: EmployeeRegistry,
    private readonly credCtx: CredentialContext,
    private readonly creds: TenantCredentialService,
    private readonly worktrees: WorktreeService,
    private readonly tokens: GithubTokenStore,
    private readonly github: GithubApiService,
    private readonly board: BoardStore,
    private readonly plans: PlanStore,
    private readonly boardEvents: BoardEventsBus,
    private readonly runner: SessionRunnerService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  private keyFor(keys: TenantKeys, engine: EWorkerEngineName): string | undefined {
    return engine === EWorkerEngineName.CODEX ? keys.openai : keys.anthropic;
  }

  /** The owner's REVIEW engine — reuse the cross-engine recipe they already declared for plan
   * self-review (SELF_REVIEW capability); fall back to their execute engine when they declare none. */
  private reviewSpec(bot: EmployeeDefinition, ctx: EmployeeContext): EngineSpec {
    const cap = bot.capabilities(ctx).find((c) => c.name === SELF_REVIEW);
    return cap ? cap.spec(ctx) : bot.executeEngine(ctx);
  }

  /** Run a read-only review turn (investigate mode) and return its prose result, or ''. */
  private async runReview(
    bot: EmployeeDefinition,
    spec: EngineSpec,
    worktreePath: string,
    team: string,
    keys: TenantKeys,
    prompt: string,
  ): Promise<string> {
    const onEvent = (_e: WorkerEvent) => undefined;
    const out = await withActiveRoot(worktreePath, () =>
      this.credCtx.run({ teamId: team, keys }, () =>
        this.engines.get(spec.engine).run({
          task: prompt,
          cwd: worktreePath,
          systemPrompt: spec.systemPrompt,
          agentId: bot.id,
          sessionId: undefined,
          model: spec.model,
          effort: spec.effort,
          mode: 'investigate',
          apiKey: this.keyFor(keys, spec.engine),
          onEvent,
        }),
      ),
    );
    return out.result?.trim() ?? '';
  }

  /**
   * Per-owner: review THIS owner's diff, fix-loop in-session, then publish onto the shared branch.
   * Marks the plan row 'complete' on success (and triggers integrate() when it's the last owner), or
   * 'blocked' + seeds the owner on a conflict / exhausted fix loop. Best-effort and self-contained:
   * it owns the owner_status writes so a partial run never strands the task silently.
   */
  async reviewOwner(session: Session): Promise<OwnerReviewOutcome> {
    const { team, ownerBot: employee, worktreeId } = session;
    const taskId = session.boardTaskId;
    if (taskId === undefined)
      return { kind: 'blocked', reason: 'session is not linked to a board task' };

    const bot = this.employees.byId(employee);
    if (!bot)
      return { kind: 'blocked', reason: `unknown employee '${employee}'` };
    const ctx = this.employees.context();
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree?.sharedBranch)
      return {
        kind: 'blocked',
        reason: `worktree ${worktreeId} has no shared branch to publish through`,
      };
    const keys = await this.creds.resolve(team);
    const task = await this.board.get(team, taskId);
    const ticketText = task
      ? `${task.title}\n\n${task.description}`.trim()
      : session.task;
    const goal = task?.title ?? session.task;

    // The shared tip BEFORE we publish — the review diffs <preRef>...<ownerBranch> (three-dot), so an
    // owner reviewing after teammates have already integrated never re-reviews their work.
    const preRef = await this.worktrees.sharedRef(worktreeId);

    // Review/fix loop runs LOCALLY (no publish yet) so the publish at the end carries the fixed work.
    if (preRef) {
      for (let pass = 0; pass <= MAX_FIX_PASSES; pass++) {
        const { range, files } = await this.worktrees.ownerDiff(
          worktreeId,
          preRef,
        );
        if (files.length === 0) break; // nothing of this owner's own to review
        const reviewText = await this.runReview(
          bot,
          this.reviewSpec(bot, ctx),
          worktree.path,
          team,
          keys,
          CODE_REVIEW_PROMPT({ goal, ticket: ticketText, range }),
        );
        if (parseVerdict(reviewText) === 'pass') break;
        if (pass === MAX_FIX_PASSES) {
          await this.plans.setOwnerStatus(team, taskId, employee, 'blocked');
          this.emitFailed(
            session,
            taskId,
            `self-review still flagged issues after ${MAX_FIX_PASSES} fix passes — take it from here`,
          );
          return {
            kind: 'blocked',
            reason: 'fix loop exhausted',
          };
        }
        // Fix the flagged issues in the owner's OWN session (harness-initiated, gate-bypassed).
        await this.runner.resumeInternal(
          session.id,
          REVIEW_FIX_PROMPT({ critique: reviewText }),
          { mode: 'execute', timeoutMs: INTERNAL_TURN_TIMEOUT_MS },
        );
      }
    }

    // Publish the (now reviewed) work onto the shared branch. A conflict is left in-progress; seed the
    // owner to resolve and re-submit — do NOT mark complete.
    const publish = await this.worktrees.publish(worktreeId).catch((err) => ({
      integrated: false as const,
      sharedBranch: worktree.sharedBranch!,
      files: [String(err instanceof Error ? err.message : err)],
    }));
    if (!publish.integrated) {
      await this.plans.setOwnerStatus(team, taskId, employee, 'blocked');
      await this.runner
        .resumeInternal(
          session.id,
          CONFLICT_RESOLVE_PROMPT({
            sharedBranch: publish.sharedBranch,
            files: publish.files ?? [],
          }),
          { mode: 'execute', timeoutMs: INTERNAL_TURN_TIMEOUT_MS },
        )
        .catch(() => undefined);
      this.emitFailed(
        session,
        taskId,
        `publishing onto ${publish.sharedBranch} hit a merge conflict (${(publish.files ?? []).join(', ') || 'see git status'}) — resolve it, then submit_for_review again`,
      );
      return { kind: 'blocked', reason: 'publish conflict' };
    }

    await this.plans.setOwnerStatus(team, taskId, employee, 'complete');

    // The last owner to finish trips the integration barrier.
    if (await this.plans.allOwnersComplete(team, taskId)) {
      await this.integrate(team, taskId).catch((err) =>
        this.logger.warn(`integrate(#${taskId}) failed: ${err}`),
      );
    }
    return { kind: 'complete' };
  }

  /**
   * Task-level barrier: open the shared-branch DRAFT PR, run a final integration review, and on a
   * clean verdict flip the PR to ready and the ticket to 'in_review'. Fired only when every owner is
   * complete. Idempotent on the status CAS so a re-trip is harmless.
   */
  async integrate(team: string, taskId: number): Promise<void> {
    const plans = await this.plans.listForTask(team, taskId);
    const anchor = plans.find((p) => p.executeWorktreeId && p.sharedBranch);
    if (!anchor?.executeWorktreeId) {
      this.logger.warn(
        `integrate(#${taskId}): no plan row carries an execute worktree — cannot open the PR`,
      );
      return;
    }
    const worktreeId = anchor.executeWorktreeId;
    // The integration-barrier milestones wake EVERY owner of the ticket (not just the anchor), each
    // in their own session's room — resolved once here.
    const owners = await this.resolveOwners(plans);

    // executing → self_review (the integration review is running). Idempotent: a no-op if a concurrent
    // trip already advanced it.
    await this.board
      .transition(team, taskId, 'executing', { status: 'self_review' })
      .catch(() => undefined);

    const rec = await this.worktrees.projectRecordFor(worktreeId);
    const task = await this.board.get(team, taskId);
    if (!rec || !task) {
      this.notifyOwners(owners, {
        kind: 'self-review-failed',
        team,
        taskId,
        reason:
          'no registered GitHub repo matches this worktree — open the PR manually',
      });
      return;
    }
    const auth = await this.tokens
      .resolve(rec.teamId, rec.tokenName)
      .catch(() => undefined);
    if (!auth) {
      this.notifyOwners(owners, {
        kind: 'self-review-failed',
        team,
        taskId,
        reason:
          'no GitHub token is stored for this project — open the PR manually',
      });
      return;
    }

    // Ensure origin has the branch (also runs the repo-identity guard) and open/find the DRAFT PR.
    let prUrl: string;
    try {
      const { sharedBranch } =
        await this.worktrees.pushSharedToOrigin(worktreeId);
      const { owner, repo } = parseGithubRepo(rec.gitUrl);
      const pr = await this.github.openPullRequest(auth.token, {
        owner,
        repo,
        head: sharedBranch,
        base: rec.defaultBranch,
        title: task.title,
        body: task.description || undefined,
        draft: true,
      });
      prUrl = pr.url;
      await this.plans.setPrUrl(team, taskId, prUrl);
      this.notifyOwners(owners, { kind: 'pr-opened', team, taskId, prUrl });
    } catch (err) {
      this.notifyOwners(owners, {
        kind: 'self-review-failed',
        team,
        taskId,
        reason: `couldn't open the PR (${err instanceof Error ? err.message : String(err)}) — open it manually`,
      });
      return;
    }

    // Final integration review over the whole shared branch.
    const bot = this.employees.byId(anchor.employee);
    if (bot) {
      const ctx = this.employees.context();
      const keys = await this.creds.resolve(team);
      const wt = this.worktrees.get(worktreeId);
      const reviewText = await this.runReview(
        bot,
        this.reviewSpec(bot, ctx),
        wt?.path ?? '',
        team,
        keys,
        INTEGRATION_REVIEW_PROMPT({
          goal: task.title,
          ticket: `${task.title}\n\n${task.description}`.trim(),
          sharedBranch: anchor.sharedBranch ?? wt?.sharedBranch ?? '',
          base: rec.defaultBranch,
        }),
      ).catch(() => '');
      if (reviewText && parseVerdict(reviewText) === 'changes') {
        this.notifyOwners(owners, {
          kind: 'self-review-failed',
          team,
          taskId,
          reason:
            'the integration review flagged issues across the combined work — fix them and submit_for_review again',
        });
        return;
      }
    }

    // Clean — flip the PR out of draft and the ticket into review.
    try {
      const { owner, repo } = parseGithubRepo(rec.gitUrl);
      const open = await this.github.listOpenPullRequests(auth.token, {
        owner,
        repo,
      });
      const pr = open.find(
        (p) => p.headBranch === (anchor.sharedBranch ?? ''),
      );
      if (pr)
        await this.github.markReadyForReview(auth.token, {
          owner,
          repo,
          number: pr.number,
        });
    } catch (err) {
      this.logger.warn(`mark-ready(#${taskId}) failed: ${err}`);
    }
    await this.board
      .transition(team, taskId, 'self_review', { status: 'in_review' })
      .catch(() => undefined);
    this.notifyOwners(owners, { kind: 'pr-ready', team, taskId, prUrl });
  }

  /** Wake the owner (real seeded narration) that a per-owner step couldn't auto-clear. */
  private emitFailed(session: Session, taskId: number, reason: string): void {
    this.boardEvents.emit({
      kind: 'self-review-failed',
      team: session.team,
      taskId,
      employee: session.ownerBot,
      reason,
      notifyThread: session.notifyThread,
    });
  }

  /** Resolve every owner of a task to (employee, their session's room) — the fan-out targets for the
   * integration-barrier milestones, so each owner is woken where their work was opened. */
  private async resolveOwners(
    plans: TaskPlan[],
  ): Promise<Array<{ employee: string; notifyThread?: string }>> {
    return Promise.all(
      plans.map(async (p) => ({
        employee: p.employee,
        notifyThread: p.sessionId
          ? (await this.sessions.get(p.sessionId))?.notifyThread
          : undefined,
      })),
    );
  }

  /** Emit an integration-barrier milestone to EVERY owner (not just the anchor) — one seed per owner,
   * each woken in their own room. The per-owner reviewOwner failures still target the single owner
   * (their conflict / exhausted fix loop is theirs to resolve). */
  private notifyOwners(
    owners: Array<{ employee: string; notifyThread?: string }>,
    ev:
      | { kind: 'pr-opened' | 'pr-ready'; team: string; taskId: number; prUrl: string }
      | { kind: 'self-review-failed'; team: string; taskId: number; reason: string },
  ): void {
    for (const o of owners)
      this.boardEvents.emit({
        ...ev,
        employee: o.employee,
        notifyThread: o.notifyThread,
      });
  }
}
