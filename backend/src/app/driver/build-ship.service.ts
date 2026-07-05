import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DecisionRecord, Job } from '../domain';
import { ENGINE_RUNNER, type EngineRunnerPort, type ExecutionTarget, type ToolImpl } from '../engine';
import { GithubPrService, LocalGitService, type FeatureSandbox } from '../git';
import { Agent, renderAgentPrompt } from '../prompt-kit';
import { TurnHarnessFactory } from '../surface/turn-harness.service';
import { laneFor } from '../surface/thread-registry';
import { DriverStoreService } from './driver-store.service';
import type { ResolvedRepo } from './repo-resolver';

/**
 * The outcome of the terminal ship sequence. Atlas opens the PR ITSELF in-sandbox, then reports its url
 * back through the `report_pr_opened` bridge tool, so `ship` LATCHES `pr_url`/`pr_number` deterministically
 * (no dependence on the reconcile poll to discover it). `prConfirmed` says whether that latch succeeded —
 * callers gate terminal state (job `done`, ledger `complete`) on it, and must NOT treat "opened" alone as
 * "shipped" (the in-sandbox open turn best-effort-catches its own failures).
 */
export type ShipOutcome =
  | { opened: true; prConfirmed: true; url: string; number: number }
  | { opened: true; prConfirmed: false }
  | { opened: false; reason: 'no-token' }
  // The pre-ship leak-scan found a hydrated-secret path committed on the branch — the PR is HARD-BLOCKED
  // (never opened). `leaked` is the offending path(s), surfaced loudly to the operator.
  | { opened: false; reason: 'leak-scan'; leaked: string[] };

/** The slice of the decision record the ship step needs (overview + decisions → the PR body). */
export type ShipRecord = Pick<DecisionRecord, 'overview' | 'decisions'>;

export interface ShipInput {
  job: Job;
  record: ShipRecord | null;
  repo: ResolvedRepo;
  sandbox: FeatureSandbox;
  /**
   * When set, stage + commit any uncommitted worktree changes under this message BEFORE shipping. The
   * thread-driver omits it (it commits per-step); the direct-build fast path sets it (the brain wrote
   * the change but hasn't committed). A clean tree → no-op.
   */
  commitMessage?: string;
  /** Optional surface relay for the "PR ready" / "no token" notices (best-effort). */
  notify?: (message: string) => Promise<void> | void;
}

/**
 * The shared TERMINAL "ship" sequence — extracted from the thread-driver's PR-tail so BOTH the full
 * thread build and the direct-build fast path finalize identically:
 *
 *   push the branch → open ONE PR (idempotent; a re-run finds the existing PR) → record `pr_url`/`pr_number`
 *   on the THREAD (which flips it to `done`, so the merge poll watches it) → relay "PR ready".
 *
 * The whole-diff review-and-fix now runs UPSTREAM as the build's last thread (the Codex master-review
 * builder — see `thread-driver.service.ts`), so the branch reaching `ship` is already reviewed and fixed;
 * `ship` just publishes it. References NO threads/steps — its only inputs are the job row, the (optional)
 * decision record, the resolved repo, and the sandbox. Returns the opened PR, or `null` when no GitHub token
 * is configured (the caller is notified; the thread stays `running` so a later token + re-run can ship it).
 */
@Injectable()
export class BuildShipService {
  private readonly logger = new Logger(BuildShipService.name);

  constructor(
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly store: DriverStoreService,
    // The @Global shared transcript spine — the in-sandbox open-PR turn rides it on the `ship:<jobId>` lane.
    private readonly turnHarness: TurnHarnessFactory,
    // Direct engine access (not `TurnRunnerService` — the open-PR turn passes its own `report_pr_opened`
    // tool bridge), same seam the brain uses for its own host-tool turns.
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
  ) {}

  async ship(input: ShipInput): Promise<ShipOutcome> {
    const { job, record, repo, sandbox } = input;
    const notify = async (m: string): Promise<void> => {
      try {
        await input.notify?.(m);
      } catch (err) {
        this.logger.debug(`ship notify failed (continuing): ${err}`);
      }
    };

    if (input.commitMessage) {
      const sha = await this.git.commitAll(
        sandbox.worktreePath,
        input.commitMessage,
      );
      this.logger.log(
        `job=${job.id} ship — committed ${sha ? sha.slice(0, 8) : '(nothing to commit)'}`,
      );
    }

    if (!repo.token) {
      this.logger.warn(
        `job=${job.id}: no GitHub token — cannot push / open PR. Leaving as running.`,
      );
      await notify(
        ':warning: Build complete but no GitHub token is configured — PR not opened.',
      );
      return { opened: false, reason: 'no-token' };
    }

    // PRE-SHIP LEAK-SCAN — a HARD gate before the PR opens. Writers own their commits now, so the hydrated-
    // secret check can no longer ride inside a host commit; it runs here instead, scanning EVERY commit on
    // the branch (`origin/<base>..HEAD`, per-commit — catches a secret added then deleted). The forbidden set
    // lives in a host-only sidecar the in-sandbox turn can't read, so this MUST be host-side, before the
    // open-PR turn. Fail CLOSED: a scan error blocks the ship (an unprovable branch is not waved through).
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
      await notify(
        ':no_entry: Pre-ship security scan could not complete — PR blocked. Check the branch and retry.',
      );
      return { opened: false, reason: 'leak-scan', leaked: [] };
    }
    if (leaked.length) {
      this.logger.error(
        `job=${job.id}: pre-ship leak-scan BLOCKED the PR — hydrated secret path(s) committed: ${leaked.join(', ')}`,
      );
      await notify(
        `:no_entry: PR blocked — a managed secret/seed file was committed on this branch: ` +
          `\`${leaked.join('`, `')}\`. These must never be committed. Remove them from history and retry.`,
      );
      return { opened: false, reason: 'leak-scan', leaked };
    }

    // OPEN, THEN REVIEW AS A CHECK. Atlas opens the PR FIRST — a final IN-SANDBOX turn (the host runs no
    // git/PR commands itself; it kicks an execute turn where Atlas, with authenticated git + `gh`, pushes
    // the branch and `gh pr create`s). Atlas reports the URL back through the `report_pr_opened` bridge tool,
    // so the host learns it deterministically here — no dependence on the reconcile poll for discovery.
    const reported = await this.openPrInSandbox(job, record, repo, sandbox, notify);

    // LATCH the completion signal. Resolve the PR by BRANCH first — `findOpenPullByHead` is scoped to
    // `sandbox.branch`, so it is authoritative for WHICH PR belongs to this build (its head IS our branch).
    // Fall back to the url Atlas reported via `report_pr_opened` ONLY when the branch lookup misses (GitHub
    // indexing lag right after `gh pr create`) AND the reported PR's HEAD really is our branch — the tool
    // only validated owner/repo, so verify the head before trusting it, else a mis-reported same-repo url
    // could latch the wrong PR.
    let confirmed = await this.discoverOpenPr(repo, sandbox);
    if (
      !confirmed &&
      reported &&
      (await this.reportedHeadMatches(repo, reported.number, sandbox.branch))
    ) {
      confirmed = reported;
    }
    if (confirmed) {
      // Record `pr_url`/`pr_number` (via `setPrReady`, which also flips `done`). Applies to onboarding too:
      // the reconciler already discovers + records an onboarding PR the same way, so latching it here is
      // consistent (the ledger backstop still excludes onboarding by kind, so no promote turn fires on it).
      await this.store.setPrReady(job.id, confirmed.url, confirmed.number);
    } else {
      // Could NOT confirm the PR url (the ship turn was interrupted before reporting AND the branch lookup
      // missed — e.g. GitHub hasn't indexed a just-created PR). Deliberately do NOT flip `done` with a null
      // `pr_url`: that strands the completion signal and makes boot-recovery re-ship the job forever (the
      // flaky-loop bug this fix targets). Leaving it `running` lets recovery re-run the idempotent ship
      // tail, which finds the existing PR and latches its url on the next pass.
      this.logger.warn(
        `job=${job.id}: ship could not confirm a PR url — leaving 'running' for recovery to re-latch`,
      );
    }

    // The whole-diff review + fixes already ran upstream (the Codex master-review builder thread), so the
    // branch is published as-is — `ship` no longer runs a review pass of its own.
    return confirmed
      ? { opened: true, prConfirmed: true, url: confirmed.url, number: confirmed.number }
      : { opened: true, prConfirmed: false };
  }

  /**
   * Best-effort direct lookup of the just-opened PR by head branch — the fallback when the ship turn didn't
   * report its url (interrupted before the `report_pr_opened` call). Returns undefined on a miss (GitHub
   * hasn't indexed the fresh PR yet) or a transient error; the caller then leaves the job for recovery.
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

  /**
   * Verify a REPORTED PR (from `report_pr_opened`, which only checked owner/repo) actually has `branch` as
   * its head, before trusting it as the branch-lookup fallback. `getPullDetail` fetches the PR by number
   * directly (available the instant it's created, unlike the `pulls?head=` list query that can lag), so this
   * is a reliable head check. Best-effort: any error → false (treat as unconfirmed rather than latch a
   * possibly-wrong PR).
   */
  private async reportedHeadMatches(
    repo: ResolvedRepo,
    number: number,
    branch: string,
  ): Promise<boolean> {
    if (!repo.token) return false;
    try {
      const detail = await this.pr.getPullDetail(repo.token, {
        owner: repo.owner,
        repo: repo.repo,
        number,
      });
      return detail.state === 'open' && detail.headRef === branch;
    } catch (err) {
      this.logger.debug(`ship: reported-PR head check failed for #${number}: ${err}`);
      return false;
    }
  }

  /**
   * THE SHIP TURN — the build's terminal in-sandbox step: Atlas RECONCILES the branch against its base
   * (`git fetch origin` + integrate any base drift, resolving conflicts) and then opens the PR itself with
   * its own git + `gh` (host touches no GitHub API). A long build can leave `origin/<base>` moved on; the
   * reconcile keeps the PR mergeable. The host-side pre-ship leak-scan gate has already run in `ship()`
   * (it reads a host-only sidecar the sandbox can't see), so this turn only reconciles + publishes.
   * Best-effort like PR Review — a failure is logged; the reconciler re-discovers on the next pass once
   * Atlas retries or the operator nudges. The target carries per-turn git auth so the push authenticates
   * and `gh` picks up the token from the exec env.
   */
  private async openPrInSandbox(
    job: Job,
    record: ShipRecord | null,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    notify: (m: string) => Promise<void>,
  ): Promise<{ url: string; number: number } | null> {
    const base = this.targetFor(sandbox);
    const target: ExecutionTarget | undefined = base
      ? { ...base, gitAuth: { gitUrl: repo.projectRepo.gitUrl, token: repo.token } }
      : undefined;
    const harness = this.turnHarness.create({
      jobId: job.id,
      channel: job.repoId,
      lane: laneFor('ship', job.id),
      metaTag: { shipId: job.id },
    });

    // Atlas reports the opened PR's url back through this bridge tool → the host latches it (see `ship`).
    // Validated against THIS repo (guards a hallucinated/wrong url) and idempotent (a repeat call just
    // re-sets the same value). The number is derived from the url, not trusted from a separate arg.
    let reported: { url: string; number: number } | null = null;
    const reportPrOpened: ToolImpl = async (args) => {
      const parsed = parsePrUrl(String(args['url'] ?? ''));
      if (!parsed) {
        return {
          ok: false,
          reason: 'url must be a full https://github.com/<owner>/<repo>/pull/<number> URL',
        };
      }
      if (
        parsed.owner.toLowerCase() !== repo.owner.toLowerCase() ||
        parsed.repo.toLowerCase() !== repo.repo.toLowerCase()
      ) {
        return {
          ok: false,
          reason: `url must be a PR on ${repo.owner}/${repo.repo} (got ${parsed.owner}/${parsed.repo})`,
        };
      }
      reported = { url: parsed.url, number: parsed.number };
      return { ok: true, recorded: reported };
    };

    try {
      await notify(':outbox_tray: Build complete — opening the PR.');
      const res = await this.engine.run({
        engine: 'claude',
        task:
          `The build is complete on branch \`${sandbox.branch}\`. RECONCILE against the base, then publish ` +
          `it as a pull request against \`${repo.defaultBranch}\`:\n` +
          `  1. RECONCILE THE BASE. Run \`git fetch origin\`. The base may have MOVED while this build ran, ` +
          `so check for drift: \`git log --oneline HEAD..origin/${repo.defaultBranch}\` (commits on the base ` +
          `you don't have yet). If there are any, integrate them — \`git merge origin/${repo.defaultBranch}\` ` +
          `(or rebase). If that produces MERGE CONFLICTS, resolve them properly (understand both sides — do ` +
          `not blindly take one), then commit the merge. Verify the tree still builds after reconciling.\n` +
          `  2. Commit anything uncommitted, then \`git push -u origin ${sandbox.branch}\`.\n` +
          `  3. Open the PR: \`gh pr create --base ${repo.defaultBranch} --head ${sandbox.branch} ` +
          `--title ${JSON.stringify(job.title ?? 'Atlas build')} --body-file -\` (pipe the body below on stdin). ` +
          `If a PR for this branch already exists, use it — don't open a second one.\n` +
          `  4. Report it: call \`report_pr_opened\` with the PR url (\`gh pr create\` prints it, or run ` +
          `\`gh pr view ${sandbox.branch} --json url -q .url\`). This step is REQUIRED — the host records the ` +
          `PR from that call.\n\n` +
          `PR body:\n${shipPrBody(job, record)}`,
        cwd: sandbox.worktreePath,
        systemPrompt: renderAgentPrompt(Agent.SHIP_OPEN_PR),
        sandboxKey: `${shipSandboxKey(sandbox)}--ship`,
        mode: 'execute',
        richStream: true,
        onEvent: (e) => harness.onEvent(e),
        ...(target ? { target } : {}),
        toolBridge: { jobId: job.id, tools: { report_pr_opened: reportPrOpened } },
      });
      await harness.finish(res.result, res.usage ? { usage: res.usage } : undefined);
      // Fallback when the model forgot the tool: pull the first PR url out of its final text, and only
      // accept it if it's on THIS repo. (The tool is the deterministic path; this rescues a missed call.)
      if (!reported) {
        const fromText = firstPrUrlIn(res.result);
        if (
          fromText &&
          fromText.owner.toLowerCase() === repo.owner.toLowerCase() &&
          fromText.repo.toLowerCase() === repo.repo.toLowerCase()
        ) {
          reported = { url: fromText.url, number: fromText.number };
        }
      }
      return reported;
    } catch (err) {
      await harness.abort().catch(() => undefined);
      this.logger.warn(`ship turn (open PR) failed for job=${job.id}: ${err}`);
      return reported; // a report that landed before the throw still counts
    }
  }

  /** The execution target for a turn — the sandbox container when the driver ran in docker mode. */
  private targetFor(sandbox: FeatureSandbox): ExecutionTarget | undefined {
    if (!sandbox.containerId) return undefined;
    return {
      containerId: sandbox.containerId,
      worktreeHost: sandbox.worktreePath,
      ...(sandbox.execUser ? { user: sandbox.execUser } : {}),
    };
  }
}

/** System prompt for the ship turn — a tight, single-purpose "open the PR" instruction (Atlas in-sandbox). */

/** Parse a GitHub PR url → owner/repo/number (+ the normalized url). Null when it is not a github.com PR url. */
function parsePrUrl(
  url: string,
): { owner: string; repo: string; number: number; url: string } | null {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), url: m[0] } : null;
}

/** The first GitHub PR url appearing in free text (the ship turn's final report) → owner/repo/number. */
function firstPrUrlIn(
  text: string | null | undefined,
): { owner: string; repo: string; number: number; url: string } | null {
  if (!text) return null;
  const m = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(text);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), url: m[0] } : null;
}

/** The PR body — feature title, decision-record overview, and the locked decisions. */
function shipPrBody(job: Job, record: ShipRecord | null): string {
  const lines = [`Automated by Atlas v2 for **${job.title}**.`, ''];
  if (record?.overview) lines.push(record.overview, '');
  if (record?.decisions.length) {
    lines.push('### Decisions');
    for (const d of record.decisions)
      lines.push(`- **${d.title}** (${d.decisionClass}): ${d.ruling}`);
  }
  return lines.join('\n');
}

/** The per-feature auto-fix key: stable across a feature's turns (`<repoId>--<branch>`). */
function shipSandboxKey(sandbox: FeatureSandbox): string {
  return `${sandbox.repoId}--${sandbox.branch}`;
}
