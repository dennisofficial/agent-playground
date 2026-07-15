import { Injectable, Logger } from '@nestjs/common';
import type { DecisionRecord, Job } from '../domain';
import { GithubPrService, LocalGitService, type FeatureSandbox } from '../git';
import { BrainGateway } from '../brain-gateway';
import { DriverStoreService } from './driver-store.service';
import type { ResolvedRepo } from './repo-resolver';

/**
 * The outcome of the terminal ship sequence. The job brain opens the PR ITSELF as a seeded harness turn in
 * its own sandbox (see {@link BuildShipService.ship}), and the HOST records the PR afterward by branch
 * discovery (`findOpenPullByHead` → `setPrReady`, backstopped by the git-state reconciler). `opened` means
 * the open-PR turn RAN; `prConfirmed` means the host latched `pr_url`/`pr_number` this pass. The open-PR turn
 * commits + pushes everything (the host NEVER commits), so callers only treat a `prConfirmed` result as
 * "the PR is recorded".
 */
export type ShipOutcome =
  | { opened: true; prConfirmed: true; url: string; number: number }
  | { opened: true; prConfirmed: false }
  | { opened: false; reason: 'no-token' }
  // The pre-ship leak-scan found a hydrated-secret path committed on the branch — the PR is HARD-BLOCKED
  // (never opened). `leaked` is the offending path(s), surfaced loudly to the operator.
  | { opened: false; reason: 'leak-scan'; leaked: string[] };

/** The host-side pre-ship gate result (no-token + leak-scan; the host NEVER commits) — shared by the driver
 *  ship path and the direct-build `finalize_build` tool. `ok` ⇒ safe to open the PR. */
export type PreShipResult =
  | { ok: true }
  | { ok: false; reason: 'no-token' }
  | { ok: false; reason: 'leak-scan'; leaked: string[] };

/** The slice of the decision record the ship step needs (overview + decisions → the PR body). */
export type ShipRecord = Pick<DecisionRecord, 'overview' | 'decisions'>;

export interface ShipInput {
  job: Job;
  record: ShipRecord | null;
  repo: ResolvedRepo;
  sandbox: FeatureSandbox;
  /** Optional surface relay for the "PR ready" / "no token" notices (best-effort). */
  notify?: (message: string) => Promise<void> | void;
}

/**
 * The shared TERMINAL "ship" sequence — used by BOTH the full thread build and the direct-build fast path so
 * they finalize identically:
 *
 *   host: pre-ship leak-scan gate → (brain: commit anything uncommitted → reconcile the branch against its
 *   base → push → author the PR body → open ONE PR) → host: record `pr_url`/`pr_number` (which flips the job
 *   `done`, so the merge poll watches it) → relay "PR ready".
 *
 * The HOST NEVER COMMITS. Every commit on the branch is authored by Atlas's own in-sandbox session (builders
 * commit per-step; the open-PR turn commits any remaining uncommitted work before it pushes). This keeps the
 * git history free of robotic host-identity commits.
 *
 * The whole-diff review-and-fix runs UPSTREAM as the build's last thread (the Codex master-review builder —
 * see `thread-driver.service.ts`), so the branch reaching `ship` is already reviewed and fixed; `ship` just
 * publishes it. The open-PR step is a SEEDED BRAIN TURN (`AgentSessionManager.openPrAtShip`), NOT a separate
 * `engine.run` — so it inherits the brain's own engine auth + git auth and renders in the Main conversation.
 * References NO threads/steps — its only inputs are the job row, the (optional) decision record, the resolved
 * repo, and the sandbox.
 */
@Injectable()
export class BuildShipService {
  private readonly logger = new Logger(BuildShipService.name);

  constructor(
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly store: DriverStoreService,
    // The neutral driver→brain gateway (the brain binds itself into it on bootstrap). Injecting it forms
    // no construction cycle — the gateway depends on nothing, unlike a `useExisting: AgentSessionManager`
    // port (the brain constructs this service, so that would deadlock DI).
    private readonly brainGateway: BrainGateway,
  ) {}

  /** The DRIVER / boot ship path (brain IDLE): host gate → seed the brain's open-PR turn → latch the PR.
   *  A caller already inside a brain turn (the direct-build `finalize_build` tool) must NOT use this — it
   *  would nest a second brain turn; it runs {@link preShip} then hands `shipOpenPrBody` to the live turn. */
  async ship(input: ShipInput): Promise<ShipOutcome> {
    const { job, repo, sandbox } = input;
    const notify = this.notifier(input.notify);

    const pre = await this.preShip(job, repo, sandbox, notify);
    if (!pre.ok) {
      return pre.reason === 'leak-scan'
        ? { opened: false, reason: 'leak-scan', leaked: pre.leaked }
        : { opened: false, reason: 'no-token' };
    }

    // FOLLOW THE LIVE BRANCH. The agent may have `git checkout -b …` mid-build, so ship/open-PR/discover
    // against the branch HEAD is actually on — not the host-named `sandbox.branch` (= feature_branch).
    // `current_branch` is kept fresh by the observation listener; re-read once as a safety net (detached
    // HEAD → null → fall back to the canonical name). Persist so discovery + GitHub-event correlation see it.
    const observed =
      job.currentBranch ?? (await this.git.currentBranch(sandbox.worktreePath));
    const shipBranch = observed ?? sandbox.branch;
    if (observed && observed !== job.currentBranch) {
      await this.store.setCurrentBranch(job.id, observed);
    }
    const shipSandbox: FeatureSandbox = { ...sandbox, branch: shipBranch };
    const prTitle = job.title?.trim() || shipBranch;

    // OPEN THE PR — as a seeded turn on the job-brain session. The brain reconciles the branch against its
    // base, pushes, authors the body, and `gh pr create`s, all with its own authenticated git + `gh`. This
    // AWAITS the brain turn to completion. No host "opening the PR" system
    // message here — the seeded turn renders on Main with its own "Opening the pull request." pill.
    const postBuild = await this.store.ensurePostBuildThread({
      jobId: job.id,
      orgId: job.orgId,
      decisionRecordId: job.decisionRecordId ?? null,
    });
    await this.brainGateway.openPrAtShip({
      jobId: job.id,
      orgId: job.orgId,
      repoId: job.repoId,
      branch: shipBranch,
      defaultBranch: repo.defaultBranch,
      title: prTitle,
      threadId: postBuild.threadId,
    });

    const confirmed = await this.latchPr(job, repo, shipSandbox);
    return confirmed
      ? {
          opened: true,
          prConfirmed: true,
          url: confirmed.url,
          number: confirmed.number,
        }
      : { opened: true, prConfirmed: false };
  }

  /**
   * HOST-SIDE PRE-SHIP GATE (shared): verify a GitHub token exists, then run the pre-ship leak-scan — a HARD
   * gate before any push. The HOST NEVER COMMITS (Atlas owns every commit); the hydrated-secret check scans
   * EVERY commit on the branch (`origin/<base>..HEAD`, per-commit — catches a secret added then deleted) AND
   * the current WORKING TREE (staged/unstaged/untracked), so an uncommitted secret the brain's ship turn is
   * about to commit is still caught here. The forbidden set lives in a host-only sidecar the in-sandbox turn
   * can't read, so this MUST run host-side, before the open-PR turn. Fail CLOSED: a scan error blocks the ship.
   */
  async preShip(
    job: Job,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    notify?: (message: string) => Promise<void>,
  ): Promise<PreShipResult> {
    const relay = this.notifier(notify);

    if (!repo.token) {
      this.logger.warn(
        `job=${job.id}: no GitHub token — cannot push / open PR. Leaving as running.`,
      );
      await relay(
        ':warning: Build complete but no GitHub token is configured — PR not opened.',
      );
      return { ok: false, reason: 'no-token' };
    }

    let leaked: string[];
    try {
      leaked = await this.git.scanBranchForForbidden(
        sandbox.worktreePath,
        `origin/${repo.defaultBranch}`,
      );
    } catch (err) {
      this.logger.error(
        `job=${job.id}: pre-ship leak-scan FAILED (blocking ship, fail-closed): ${err}`,
      );
      await relay(
        ':no_entry: Pre-ship security scan could not complete — PR blocked. Check the branch and retry.',
      );
      return { ok: false, reason: 'leak-scan', leaked: [] };
    }
    if (leaked.length) {
      this.logger.error(
        `job=${job.id}: pre-ship leak-scan BLOCKED the PR — hydrated secret path(s) committed: ${leaked.join(', ')}`,
      );
      await relay(
        `:no_entry: PR blocked — a managed secret/seed file was committed on this branch: ` +
          `\`${leaked.join('`, `')}\`. These must never be committed. Remove them from history and retry.`,
      );
      return { ok: false, reason: 'leak-scan', leaked };
    }

    return { ok: true };
  }

  /**
   * LATCH the completion signal after the brain opened the PR. Resolve the PR by BRANCH
   * (`findOpenPullByHead` is scoped to `sandbox.branch`, so it is authoritative for WHICH PR belongs to this
   * build — its head IS our branch) and record `pr_url`/`pr_number` via `setPrReady` (which also flips the
   * job `done`). Returns undefined when GitHub hasn't indexed the just-created PR yet: we deliberately do NOT
   * flip `done` with a null `pr_url` — that strands the completion signal. The job stays `running` and the
   * git-state reconciler re-discovers + latches it on its next pass (or a re-drive re-runs this).
   */
  async latchPr(
    job: Job,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Promise<{ url: string; number: number } | undefined> {
    const confirmed = await this.discoverOpenPr(repo, sandbox);
    if (confirmed) {
      await this.store.setPrReady(job.id, confirmed.url, confirmed.number);
      // Post-ship seam (d14): the PR is recorded — ensure the job's `ci` stage-thread exists so inbound
      // GitHub/CI events have somewhere to route (the routing itself is thread 4's §CI-routing seam).
      await this.store.ensureCiThread({
        jobId: job.id,
        orgId: job.orgId,
        decisionRecordId: job.decisionRecordId ?? null,
      });
      return confirmed;
    }
    this.logger.warn(
      `job=${job.id}: ship could not confirm a PR url yet — leaving 'running' for the reconciler to latch`,
    );
    return undefined;
  }

  /** Wrap an optional caller notify into an always-callable, best-effort relay (never throws). */
  private notifier(
    notify?: (message: string) => Promise<void> | void,
  ): (m: string) => Promise<void> {
    return async (m: string) => {
      try {
        await notify?.(m);
      } catch (err) {
        this.logger.debug(`ship notify failed (continuing): ${err}`);
      }
    };
  }

  /**
   * Look up the open PR by head branch — authoritative for THIS build (its head IS our branch). Returns
   * undefined on a miss (GitHub hasn't indexed the fresh PR yet) or a transient error; the caller then leaves
   * the job for the reconciler.
   */
  private async discoverOpenPr(
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Promise<{ url: string; number: number } | undefined> {
    if (!repo.token) return undefined;
    try {
      const found = await this.pr.findOpenPullByHead(repo.token, {
        owner: repo.owner,
        repo: repo.repo,
        head: sandbox.branch,
      });
      return found ?? undefined;
    } catch (err) {
      this.logger.debug(
        `ship: PR discovery by head failed for ${repo.owner}/${repo.repo}#${sandbox.branch}: ${err}`,
      );
      return undefined;
    }
  }
}
