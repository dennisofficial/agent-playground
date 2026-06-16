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
import { BoardStore, type BoardStatus } from '../memory/board-store';
import { BoardEventsBus } from '../memory/board-events.bus';
import { PlanStore, type TaskPlan } from '../memory/plan-store';
import { TicketNoteStore } from '../memory/ticket-note-store';
import { parseGithubRepo } from '../projects/git-auth';
import { GithubApiService } from '../projects/github-api.service';
import { GithubTokenStore } from '../projects/github-token-store';
import { WorktreeService } from '../worktrees/worktree.service';
import { EnvService } from '@core/config/env/env.service';
import {
  CODE_REVIEW_PROMPT,
  CONFLICT_RESOLVE_PROMPT,
  INTEGRATION_REVIEW_PROMPT,
  REVIEW_FIX_PROMPT,
  SELF_REVIEW_PR_COMMENT,
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

/** A ticket is "published" (its work is on the shared branch) once it reaches self_review or beyond —
 * the sibling-ship gate keys off this without joining the plan rows. */
const PUBLISHED_STATUSES: readonly BoardStatus[] = [
  'self_review',
  'in_review',
  'done',
];

/** One block per ticket in a shared feature — fed into the integration review prompt + the PR body so
 * both describe the WHOLE combined work, not just whichever ticket opened the draft PR first. */
function aggregateTicketText(
  tickets: ReadonlyArray<{ id: number; title: string; description: string }>,
): string {
  return tickets
    .map(
      (t) => `#${t.id} ${t.title}${t.description ? ` — ${t.description}` : ''}`,
    )
    .join('\n\n');
}

/**
 * The harness-driven PR self-review pipeline — the built-in replacement for the prose instruction
 * Sam kept forgetting ("self-review the PR, then mark it ready"). It runs as a SessionsModule service
 * (it already has the engines, credentials, worktree and session runner it needs; ProjectsModule adds
 * the GitHub client) and is invoked by the `submit_for_review` tool.
 *
 * One employee owns a ticket. Tickets that share a `shared_slug` converge on ONE `shared/<slug>`
 * branch + PR and ship together once all are published. Entry points:
 *  - reviewOwner(session): reviews the owner's diff (cross-engine, read-only), runs a bounded in-session
 *    fix loop, publishes onto the shared branch, marks the plan row 'complete', then trips integrate().
 *    A publish conflict / exhausted fix loop marks the row 'blocked' and seeds the owner — never completes.
 *  - integrate(team, taskId): the barrier. Opens the shared-branch DRAFT PR; once every sibling ticket
 *    on the branch is published, runs the integration review (siblings>1 only) and ships via shipSharedPr
 *    (advisory) or seeds the owner (gated). The harness never judges the review pass/fail (the #49 loop).
 *  - shipSharedPr(team, taskId): the single ship — flips the PR ready, flips every sibling → in_review,
 *    fans pr-ready, aggregates PR metadata. Called by advisory integrate() and by mark_pr_ready.
 *
 * Every milestone emits a board event so the conductor wakes the owner to narrate it in their own voice.
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
    private readonly notes: TicketNoteStore,
    private readonly boardEvents: BoardEventsBus,
    private readonly runner: SessionRunnerService,
    private readonly env: EnvService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  private keyFor(
    keys: TenantKeys,
    engine: EWorkerEngineName,
  ): string | undefined {
    return engine === EWorkerEngineName.CODEX ? keys.openai : keys.anthropic;
  }

  /** The owner's REVIEW engine — reuse the cross-engine recipe they already declared for plan
   * self-review (SELF_REVIEW capability); fall back to their execute engine when they declare none. */
  private reviewSpec(
    bot: EmployeeDefinition,
    ctx: EmployeeContext,
  ): EngineSpec {
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
   * Per-owner PEER entry (submit_for_review): run the review STAGE, then — on a clean publish — mark
   * the plan row 'complete' and trip the integration barrier (which ships once every sibling is
   * published). A blocked stage already narrated + persisted owner_status='blocked'; pass it through.
   */
  async reviewOwner(session: Session): Promise<OwnerReviewOutcome> {
    const outcome = await this.reviewStage(session);
    if (outcome.kind !== 'complete') return outcome;
    const { team } = session;
    const taskId = session.boardTaskId!;
    await this.plans.setOwnerStatus(team, taskId, 'complete');
    // This owner published — trip the integration barrier. For a shared feature it only ships once
    // every sibling ticket is published too (the gate lives in integrate()).
    await this.integrate(team, taskId).catch((err) =>
      this.logger.warn(`integrate(#${taskId}) failed: ${err}`),
    );
    return { kind: 'complete' };
  }

  /**
   * The reusable review STAGE — review THIS session's own diff, run a bounded in-session fix loop,
   * then publish the reviewed work onto the shared branch. Returns {kind:'complete'} on a clean
   * publish (the CALLER owns the mark-complete / integrate / ship tail), or {kind:'blocked'} after a
   * LOUD, recoverable owner_status='blocked' write + narration (missing worktree, exhausted fix loop,
   * or a publish conflict left in-progress for the owner to resolve). Shared by the peer reviewOwner()
   * and the Atlas pipeline's review stage.
   */
  async reviewStage(session: Session): Promise<OwnerReviewOutcome> {
    const { team, ownerBot: employee, worktreeId } = session;
    const taskId = session.boardTaskId;
    if (taskId === undefined)
      return {
        kind: 'blocked',
        reason: 'session is not linked to a board task',
      };

    const bot = this.employees.byId(employee);
    if (!bot) {
      await this.failOwner(
        session,
        taskId,
        `unknown employee '${employee}' — can't run self-review`,
      );
      return { kind: 'blocked', reason: `unknown employee '${employee}'` };
    }
    const ctx = this.employees.context();
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) {
      await this.failOwner(
        session,
        taskId,
        `worktree ${worktreeId} no longer exists — can't run self-review`,
      );
      return { kind: 'blocked', reason: 'worktree gone' };
    }
    const task = await this.board.get(team, taskId);
    // Self-heal: the worktree never joined a shared branch at execute start (the stamping no-op'd or
    // these sessions predate it). Promote it at the base divergence point — using the ticket's shared
    // slug (or `ticket-N` solo) so the branch identity matches the sibling grouping — so the owner's
    // own diff is reviewable instead of silently giving up. A failure here is a loud recoverable dead end.
    if (!worktree.sharedBranch) {
      const healed = await this.worktrees.ensureSharedAtBase(
        worktreeId,
        task?.sharedSlug ?? `ticket-${taskId}`,
      );
      if (!healed.ok) {
        await this.failOwner(
          session,
          taskId,
          `couldn't prepare a shared branch for review: ${healed.reason}`,
        );
        return { kind: 'blocked', reason: healed.reason };
      }
    }
    // Backfill the plan row's execute context (idempotent) so the integration barrier's anchor lookup
    // (`executeWorktreeId && sharedBranch`) can find this owner — a row promoted-but-never-stamped
    // would otherwise mark 'complete' and then strand integrate() with no anchor.
    await this.plans
      .setExecuteContext(team, taskId, {
        executeWorktreeId: worktreeId,
        sharedBranch: worktree.sharedBranch,
      })
      .catch(() => undefined);
    const keys = await this.creds.resolve(team);
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
          await this.failOwner(
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
      await this.plans.setOwnerStatus(team, taskId, 'blocked');
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

    return { kind: 'complete' };
  }

  /**
   * Task-level barrier (fired when THIS ticket's owner publishes). Opens the shared-branch DRAFT PR,
   * then — once every ticket sharing the branch is published — runs the final integration review and
   * ships. The harness NEVER judges pass/fail on the review (that non-deterministic gate was the #49
   * loop); INTEGRATION_REVIEW_MODE picks the hand-off: 'advisory' (default) auto-ships + comments
   * findings, 'gated' parks findings and seeds the owner. SIBLING-AWARE: tickets sharing a `shared_slug`
   * land on ONE PR and ship together once all are published (the last to finish ships); a solo ticket
   * ships on its own and skips the integration review (its per-owner pass already covered the diff).
   * Idempotent on the status CAS, so a re-trip is harmless.
   */
  async integrate(team: string, taskId: number): Promise<void> {
    const task = await this.board.get(team, taskId);
    if (!task) return;
    const plans = await this.plans.listForTask(team, taskId);
    // The executing owner = the plan row that carries an execute worktree (robust to any stray
    // planning-only rows). One employee owns a ticket.
    const anchor = plans.find((p) => p.executeWorktreeId && p.sharedBranch);
    if (!anchor?.executeWorktreeId) {
      this.logger.warn(
        `integrate(#${taskId}): no plan row carries an execute worktree — cannot open the PR`,
      );
      // Still 'executing' (no transition yet) → resubmittable; narrate the miss to the assignee.
      this.emitOwnerFailed(
        team,
        taskId,
        task.assignee,
        undefined,
        'no execute worktree is recorded for this ticket — re-run submit_for_review to retry',
      );
      return;
    }
    const worktreeId = anchor.executeWorktreeId;
    const owner = {
      employee: anchor.employee,
      notifyThread: await this.ownerRoom(anchor),
    };

    // executing → self_review (this ticket's work is published; review/ship pending). Idempotent.
    await this.board
      .transition(team, taskId, 'executing', { status: 'self_review' })
      .catch(() => undefined);

    const rec = await this.worktrees.projectRecordFor(worktreeId);
    if (!rec) {
      await this.failIntegration(
        team,
        taskId,
        owner,
        'no registered GitHub repo matches this worktree — open the PR manually',
      );
      return;
    }
    const auth = await this.tokens
      .resolve(rec.teamId, rec.tokenName)
      .catch(() => undefined);
    if (!auth) {
      await this.failIntegration(
        team,
        taskId,
        owner,
        'no GitHub token is stored for this project — open the PR manually',
      );
      return;
    }

    // Ensure origin has the branch (also runs the repo-identity guard) and open/find the DRAFT PR.
    // Title prefers the slug (the PR may carry several tickets); body is fleshed out at ship time.
    const { owner: ghOwner, repo } = parseGithubRepo(rec.gitUrl);
    let prUrl: string;
    try {
      const { sharedBranch } =
        await this.worktrees.pushSharedToOrigin(worktreeId);
      const pr = await this.github.openPullRequest(auth.token, {
        owner: ghOwner,
        repo,
        head: sharedBranch,
        base: rec.defaultBranch,
        title: task.sharedSlug ?? task.title,
        body: task.description || undefined,
        draft: true,
      });
      prUrl = pr.url;
      await this.plans.setPrUrl(team, taskId, prUrl);
      this.boardEvents.emit({
        kind: 'pr-opened',
        team,
        taskId,
        employee: owner.employee,
        prUrl,
        notifyThread: owner.notifyThread,
      });
    } catch (err) {
      await this.failIntegration(
        team,
        taskId,
        owner,
        `couldn't open the PR (${err instanceof Error ? err.message : String(err)}) — open it manually`,
      );
      return;
    }

    // SIBLING GATE: a shared-slug feature lands on one PR; ship only once every contributing ticket is
    // published (status ∈ self_review/in_review/done). Not all published → this ticket waits in
    // self_review (PR stays draft); the last sibling to publish trips the ship.
    const siblings = task.sharedSlug
      ? await this.board.list({
          team,
          project: task.project,
          sharedSlug: task.sharedSlug,
        })
      : [task];
    const pending = siblings.filter(
      (s) => !PUBLISHED_STATUSES.includes(s.status),
    );
    if (pending.length > 0) {
      this.logger.log(
        `integrate(#${taskId}): shared PR waiting on ${pending.map((s) => `#${s.id}`).join(', ')}`,
      );
      return;
    }

    // All contributors published → the final fresh-eyes, different-engine pass over the COMBINED work.
    // Only meaningful for a real feature group (siblings>1); a solo ticket's per-owner review covered it.
    let reviewText = '';
    const bot = this.employees.byId(anchor.employee);
    if (siblings.length > 1 && bot) {
      const ctx = this.employees.context();
      const keys = await this.creds.resolve(team);
      const wt = this.worktrees.get(worktreeId);
      reviewText = await this.runReview(
        bot,
        this.reviewSpec(bot, ctx),
        wt?.path ?? '',
        team,
        keys,
        INTEGRATION_REVIEW_PROMPT({
          goal: task.sharedSlug ?? task.title,
          ticket: aggregateTicketText(siblings),
          sharedBranch: anchor.sharedBranch ?? wt?.sharedBranch ?? '',
          base: rec.defaultBranch,
        }),
      ).catch(() => '');
    }
    const findings = reviewText.trim();

    if (this.env.get('INTEGRATION_REVIEW_MODE') === 'gated') {
      await this.handOffToOwner(team, taskId, owner, anchor, prUrl, findings);
      return;
    }

    // advisory (default): ship the shared PR — flips it ready, flips every sibling → in_review, fans
    // pr-ready, aggregates the PR metadata, and (when the review flagged something) comments it. Loud
    // fail rolls this ticket back so it never advances onto a still-draft PR (the #38 bug).
    const shipped = await this.shipSharedPr(team, taskId, {
      findings:
        findings && parseVerdict(reviewText) === 'changes' ? findings : undefined,
    });
    if (!shipped.ok)
      await this.failIntegration(
        team,
        taskId,
        owner,
        `${shipped.reason ?? "couldn't flip the PR out of draft"} — mark it ready manually`,
      );
  }

  /**
   * The single ship path for the shared PR — advisory `integrate()` calls it automatically;
   * `mark_pr_ready` calls it for the owner-decided (gated / manual) path. Flips the PR ready, flips
   * EVERY sibling ticket (same shared_slug) → in_review, fans `pr-ready` to each owner, aggregates the
   * PR title/body across siblings, and (when `findings` given) posts them as a PR comment + a note on
   * each sibling. Self-contained (resolves task/anchor/repo/PR from the id). Loud-fail on mark-ready
   * (returns `{ok:false}`) so the caller never advances a ticket onto a still-draft PR.
   */
  async shipSharedPr(
    team: string,
    taskId: number,
    opts: { findings?: string } = {},
  ): Promise<{ ok: boolean; reason?: string }> {
    const task = await this.board.get(team, taskId);
    if (!task) return { ok: false, reason: `board task #${taskId} is gone` };
    const plans = await this.plans.listForTask(team, taskId);
    const anchor = plans.find((p) => p.executeWorktreeId && p.sharedBranch);
    if (!anchor?.executeWorktreeId || !anchor.sharedBranch)
      return { ok: false, reason: 'no execute worktree / shared branch for this ticket' };
    const rec = await this.worktrees.projectRecordFor(anchor.executeWorktreeId);
    if (!rec) return { ok: false, reason: 'no registered GitHub repo matches this worktree' };
    const auth = await this.tokens
      .resolve(rec.teamId, rec.tokenName)
      .catch(() => undefined);
    if (!auth) return { ok: false, reason: 'no GitHub token is stored for this project' };
    const { owner: ghOwner, repo } = parseGithubRepo(rec.gitUrl);
    const open = await this.github
      .listOpenPullRequests(auth.token, { owner: ghOwner, repo })
      .catch(() => []);
    const pr = open.find((p) => p.headBranch === anchor.sharedBranch);
    if (!pr) return { ok: false, reason: `no open PR found for ${anchor.sharedBranch}` };

    try {
      await this.github.markReadyForReview(auth.token, {
        owner: ghOwner,
        repo,
        number: pr.number,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `couldn't flip the PR out of draft (${err instanceof Error ? err.message : String(err)})`,
      };
    }

    const siblings = task.sharedSlug
      ? await this.board.list({
          team,
          project: task.project,
          sharedSlug: task.sharedSlug,
        })
      : [task];

    // Aggregate the PR title/body across the feature's tickets (the draft was opened with just one).
    if (siblings.length > 1)
      await this.github
        .updatePullRequest(auth.token, {
          owner: ghOwner,
          repo,
          number: pr.number,
          title: task.sharedSlug ?? task.title,
          body: aggregateTicketText(siblings),
        })
        .catch((err) =>
          this.logger.warn(`PR metadata update(#${taskId}) failed: ${err}`),
        );

    // Advisory findings → one comment on the PR (covers the whole feature).
    if (opts.findings)
      await this.github
        .commentOnPullRequest(auth.token, {
          owner: ghOwner,
          repo,
          number: pr.number,
          body: SELF_REVIEW_PR_COMMENT(opts.findings),
        })
        .catch((err) =>
          this.logger.warn(`self-review PR comment(#${taskId}) failed: ${err}`),
        );

    // Flip every sibling → in_review and narrate readiness to its own owner.
    for (const s of siblings) {
      await this.board
        .transition(team, s.id, 'self_review', { status: 'in_review' })
        .catch(() => undefined);
      if (opts.findings)
        await this.notes
          .add(team, s.id, anchor.employee, opts.findings)
          .catch(() => undefined);
      const sOwner = await this.ownerOf(team, s.id);
      this.boardEvents.emit({
        kind: 'pr-ready',
        team,
        taskId: s.id,
        employee: sOwner?.employee ?? s.assignee ?? anchor.employee,
        prUrl: pr.url,
        notifyThread: sOwner?.notifyThread,
      });
    }
    return { ok: true };
  }

  /**
   * The single-task PR ship for the Atlas pipeline's PR gate — open (or find) the PR for THIS task's
   * worktree and mark it ready, with NO sibling/sharedSlug fan-out (the peer `integrate`/`shipSharedPr`
   * path stays untouched). Self-heals a missing shared branch (the ticket's slug or `ticket-N`),
   * publishes the accumulated pipeline work, pushes to origin, opens a READY PR (base = the project's
   * default branch), flips the ticket → in_review, stamps the PR url, and narrates pr-ready. Loud-fail
   * ({ok:false}) on any infra miss so the caller never reports a ship that didn't happen.
   */
  async shipTask(opts: {
    team: string;
    taskId: number;
    worktreeId: string;
    notifyThread?: string;
  }): Promise<{ ok: boolean; reason?: string; prUrl?: string }> {
    const { team, taskId, worktreeId } = opts;
    const task = await this.board.get(team, taskId);
    if (!task) return { ok: false, reason: `board task #${taskId} is gone` };
    let worktree = this.worktrees.get(worktreeId);
    if (!worktree)
      return { ok: false, reason: `worktree ${worktreeId} no longer exists` };
    // The PR opens off the worktree's shared branch; self-heal one at the base divergence point when
    // the pipeline worktree never joined one (solo task → `ticket-N`, or the ticket's slug).
    if (!worktree.sharedBranch) {
      const healed = await this.worktrees.ensureSharedAtBase(
        worktreeId,
        task.sharedSlug ?? `ticket-${taskId}`,
      );
      if (!healed.ok)
        return {
          ok: false,
          reason: `couldn't prepare a branch for the PR: ${healed.reason}`,
        };
      worktree = this.worktrees.get(worktreeId);
      if (!worktree)
        return { ok: false, reason: `worktree ${worktreeId} disappeared` };
    }
    const wt = worktree; // const for the publish catch closure
    // Publish the accumulated pipeline work onto the shared branch; a conflict is left in-progress.
    const publish = await this.worktrees.publish(worktreeId).catch((err) => ({
      integrated: false as const,
      sharedBranch: wt.sharedBranch ?? '(unknown)',
      files: [String(err instanceof Error ? err.message : err)],
    }));
    if (!publish.integrated)
      return {
        ok: false,
        reason: `publishing onto ${publish.sharedBranch} hit a merge conflict (${(publish.files ?? []).join(', ') || 'see git status'}) — resolve it`,
      };

    const rec = await this.worktrees.projectRecordFor(worktreeId);
    if (!rec)
      return {
        ok: false,
        reason: 'no registered GitHub repo matches this worktree',
      };
    const auth = await this.tokens
      .resolve(rec.teamId, rec.tokenName)
      .catch(() => undefined);
    if (!auth)
      return { ok: false, reason: 'no GitHub token is stored for this project' };
    const { owner: ghOwner, repo } = parseGithubRepo(rec.gitUrl);
    let prUrl: string;
    try {
      const { sharedBranch } =
        await this.worktrees.pushSharedToOrigin(worktreeId);
      const pr = await this.github.openPullRequest(auth.token, {
        owner: ghOwner,
        repo,
        head: sharedBranch,
        base: rec.defaultBranch,
        title: task.title,
        body: task.description || undefined,
        draft: false,
      });
      prUrl = pr.url;
      // openPullRequest opens ready (draft:false); flip an already-open DRAFT to ready too (idempotent).
      await this.github
        .markReadyForReview(auth.token, {
          owner: ghOwner,
          repo,
          number: pr.number,
        })
        .catch(() => undefined);
    } catch (err) {
      return {
        ok: false,
        reason: `couldn't open the PR (${err instanceof Error ? err.message : String(err)})`,
      };
    }

    await this.plans.setPrUrl(team, taskId, prUrl).catch(() => undefined);
    // → in_review (PR open). Non-CAS update: a pipeline task may sit in any pre-ship status.
    await this.board
      .update(team, taskId, { status: 'in_review' })
      .catch(() => undefined);
    this.boardEvents.emit({
      kind: 'pr-ready',
      team,
      taskId,
      employee: task.assignee ?? this.employees.fallbackOwner().id,
      prUrl,
      notifyThread: opts.notifyThread,
    });
    return { ok: true, prUrl };
  }

  /** gated mode: park the findings under a ticket-note id and wake the OWNER to decide — ship it
   * (mark_pr_ready → shipSharedPr) or fix from the note and resubmit. The ticket stays in self_review;
   * a failed note write is a recoverable infra dead end (rolls back so a resubmit retries). */
  private async handOffToOwner(
    team: string,
    taskId: number,
    owner: { employee: string; notifyThread?: string },
    anchor: TaskPlan,
    prUrl: string,
    findings: string,
  ): Promise<void> {
    const note = await this.notes
      .add(
        team,
        taskId,
        anchor.employee,
        findings || 'Self-review completed — no issues surfaced.',
      )
      .catch(() => undefined);
    if (!note) {
      await this.failIntegration(
        team,
        taskId,
        owner,
        "couldn't save the self-review findings to the ticket — submit_for_review again to retry",
      );
      return;
    }
    this.boardEvents.emit({
      kind: 'self-review-ready',
      team,
      taskId,
      employee: owner.employee,
      prUrl,
      noteId: note.id,
      worktreeId: anchor.executeWorktreeId!,
      sessionId: anchor.sessionId,
      notifyThread: owner.notifyThread,
    });
  }

  /** A ticket's executing owner (the plan row with an execute worktree) + its session's room. */
  private async ownerOf(
    team: string,
    taskId: number,
  ): Promise<{ employee: string; notifyThread?: string } | undefined> {
    const plans = await this.plans.listForTask(team, taskId);
    const anchor = plans.find((p) => p.executeWorktreeId);
    if (!anchor) return undefined;
    return { employee: anchor.employee, notifyThread: await this.ownerRoom(anchor) };
  }

  /** The room an owner's execute session relays into (its notifyThread), or undefined for the default. */
  private async ownerRoom(anchor: TaskPlan): Promise<string | undefined> {
    return anchor.sessionId
      ? (await this.sessions.get(anchor.sessionId))?.notifyThread
      : undefined;
  }

  /** Narrate an integration dead end to the ticket's owner (no rollback — caller decides). */
  private emitOwnerFailed(
    team: string,
    taskId: number,
    employee: string | undefined,
    notifyThread: string | undefined,
    reason: string,
  ): void {
    if (!employee) {
      this.logger.warn(`integrate(#${taskId}): ${reason} (no owner to narrate to)`);
      return;
    }
    this.boardEvents.emit({
      kind: 'self-review-failed',
      team,
      taskId,
      employee,
      reason,
      notifyThread,
    });
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

  /** A LOUD per-owner dead end: persist `owner_status='blocked'` AND narrate it, so a bot can never
   * be told "review is running" and then silently loop. The single funnel for every reviewOwner
   * failure that isn't auto-recoverable. */
  private async failOwner(
    session: Session,
    taskId: number,
    reason: string,
  ): Promise<void> {
    await this.plans
      .setOwnerStatus(session.team, taskId, 'blocked')
      .catch(() => undefined);
    this.emitFailed(session, taskId, reason);
  }

  /** Public entry for the `submit_for_review` fire-and-forget `.catch()`: an UNEXPECTED throw out of
   * reviewOwner (its known dead ends already self-report) must not vanish as an unhandled rejection —
   * mark the owner blocked + narrate so the bot hears about it. */
  async reportOwnerCrash(session: Session, reason: string): Promise<void> {
    if (session.boardTaskId === undefined) return;
    await this.failOwner(session, session.boardTaskId, reason);
  }

  /** A LOUD + RECOVERABLE integration dead end (everything past the executing→self_review flip): roll
   * the ticket BACK to 'executing' so the standard submit_for_review path can re-trip the barrier
   * after the human/config fix (the owner's row stays 'complete', so a single resubmit re-runs
   * reviewOwner → integrate), and narrate the reason to the owner. Without the rollback the ticket
   * would strand in self_review, where submit_for_review's status guard rejects every resubmit. */
  private async failIntegration(
    team: string,
    taskId: number,
    owner: { employee: string; notifyThread?: string },
    reason: string,
  ): Promise<void> {
    await this.board
      .transition(team, taskId, 'self_review', { status: 'executing' })
      .catch(() => undefined);
    this.boardEvents.emit({
      kind: 'self-review-failed',
      team,
      taskId,
      employee: owner.employee,
      reason,
      notifyThread: owner.notifyThread,
    });
  }
}
