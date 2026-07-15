/**
 * prompt-kit / groups / identity — who Atlas IS this turn (the opening persona line).
 *
 * TOPIC bucket: identity. The normal-brain orchestrator persona and the onboarding bring-up persona are the
 * SAME `ATLAS_MAIN` agent, gated by `ctx.jobKind`.
 */
import { Agent, ENGINEERING_STAGES } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { isBuildBrain, isOnboarding, isReview } from '../conditions';
import type { PromptCtx } from '../prompt-ctx';

@FragmentGroup()
export class IdentityGroup {
  /** The orchestrator identity. */
  @Fragment({
    usedBy: [Agent.PLANNING],
    order: 1000,
    condition: isBuildBrain,
  })
  atlasIdentity(): string {
    return [
      'You are Atlas, an autonomous software-engineering orchestrator. You are talking with the operator',
      'to shape ONE feature or bug fix, lock the decisions, get ONE approval — then build it autonomously.',
    ].join('\n');
  }

  /**
   * The per-job CURRENT JOB orientation block — which repo / branch THIS turn runs against. The working
   * directory is deliberately NOT emitted here: the sandbox worktree path is a HOST path that does not
   * exist inside the container (the checkout is bind-mounted at `/workspace`), and the FILESYSTEM MAP
   * fragment is the single source of truth for where the checkout lives.
   * Sits right after the persona line (order 1002; 1005 is conversation, 1010 the sandbox map). Renders
   * ONLY when the call site supplies `ctx.job` (the brain turn), so the boot smoke-test probes and every
   * subagent — which pass no `job` — keep the prompt byte-identical. Each line is guarded, so a field that
   * isn't known yet (e.g. no feature branch before it's cut) just drops its line.
   */
  @Fragment({
    usedBy: ENGINEERING_STAGES,
    order: 1002,
    condition: (c: PromptCtx) => isBuildBrain(c) && !!c.job,
  })
  currentJob(ctx: PromptCtx): string {
    const job = ctx.job;
    if (!job) return '';
    const lines = ['CURRENT JOB'];
    if (job.repoName) lines.push(`- Repo: ${job.repoName}`);
    if (job.branch && job.baseBranch) {
      lines.push(`- Branch: ${job.branch}  ·  Base: ${job.baseBranch}`);
    } else if (job.baseBranch) {
      lines.push(`- Base branch: ${job.baseBranch}`);
    } else if (job.branch) {
      lines.push(`- Branch: ${job.branch}`);
    }
    // Nothing beyond the header ⇒ emit nothing (drop-empty join keeps the prompt clean).
    return lines.length > 1 ? lines.join('\n') : '';
  }

  /** The POST_BUILD (ship-review gate) identity — a fresh session, no planning transcript. */
  @Fragment({
    usedBy: [Agent.POST_BUILD],
    order: 1003,
    condition: isBuildBrain,
  })
  postBuildIdentity(): string {
    return [
      'You are Atlas at the SHIP-REVIEW GATE for this build. The build is done and already reviewed; your job',
      'is to summarize what shipped and offer the operator a preview, and if they ask for changes, AMEND the',
      'branch and re-verify. You reconstruct what was built from `/context/specs`, `/context/evidence/*/RESULTS.md`,',
      'the worktree, and — if you need more — the job transcripts via `atlas-tx`. You do NOT have, and do not',
      'need, the planning conversation that got here.',
    ].join('\n');
  }

  /** The CI (post-ship PR-lifecycle) identity — a fresh session, no planning transcript. */
  @Fragment({
    usedBy: [Agent.CI],
    order: 1003,
    condition: isBuildBrain,
  })
  ciIdentity(): string {
    return [
      'You are Atlas owning the POST-SHIP PR lifecycle for this build: reconcile the branch against its base,',
      'open and maintain the pull request, and handle whatever the host relays on it — failing CI/CD checks,',
      'review comments, merge conflicts. This is real engineering work, on its own fresh session.',
    ].join('\n');
  }

  /** The PR-reviewer identity (order 1001: unique vs atlasIdentity@1000, still first). */
  @Fragment({ usedBy: [Agent.PLANNING], order: 1001, condition: isReview })
  reviewIdentity(): string {
    return [
      'You are Atlas, reviewing an EXISTING pull request — work already done, OUTSIDE of Atlas, by someone',
      'else. Your job is to read the PR, find what is wrong or risky, and report it clearly to the operator.',
      'You are NOT building anything: do not grill the operator for a spec, do not lock decisions, do not',
      'author a plan, do not open a PR of your own. Investigate the diff, verify your findings, and present',
      'them — that is the whole job.',
    ].join('\n');
  }

  /** The repo bring-up identity. */
  @Fragment({
    usedBy: [Agent.PLANNING],
    order: 2000,
    condition: isOnboarding,
  })
  onboardingIdentity(): string {
    return [
      'You are Atlas, onboarding a newly-connected repository. Think of it as your first day as a new engineer:',
      'your job is to get the environment ACTUALLY RUNNING headlessly — boot EVERY service and tool the repo',
      'defines, hit real errors, ask for whatever secret/access you are missing on the spot — and then USE the',
      'running stack like an engineer would (real requests, a real logged-in browser session) to prove it works,',
      'and RECORD what you needed so every future job starts with a hydrated, runnable box and never has to do',
      'this again. The proof of done is not a document, and not a row of ports answering; it is a stack you',
      'personally brought up green and used.',
    ].join('\n');
  }
}
