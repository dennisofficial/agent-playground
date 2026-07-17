import { Logger } from '@nestjs/common';
import type { EngineRunResult, RunEngineArgs } from '@shared/engine';
import { randomUUID } from 'node:crypto';
import type { ClassifierLlm } from '../decision-gate/classifier-llm';
import type { FeatureSandbox, OpenPullRequestArgs, ProjectRepo, PullRequestResult } from '../git';

/**
 * OFFLINE STUBS for the `e2e` harness default (deterministic, no-LLM, no-outward-action) mode.
 *
 * Every seam that would (a) call a real LLM or (b) take a real outward action (clone/commit/push, open
 * a GitHub PR, write files via the agent SDK) is replaced by a tiny in-process fake that returns canned,
 * deterministic values. The wiring + control flow are exercised for real against live Postgres; only the
 * three external boundaries are faked. The fakes are bound via `Test.createTestingModule().overrideProvider`
 * (see `e2e-harness.service.ts`), so the rest of the REAL `AppModule` graph composes unchanged.
 *
 * Zero v1 imports — these implement only the Atlas-owned ports.
 */

/**
 * Fake `CLASSIFIER_LLM` — the ambiguous-tail adjudicator the real `DecisionClassifier` only
 * consults when its deterministic rules are silent. Deterministic stand-in for a conservative model:
 *  - DESTRUCTIVE / always-ask-shaped text → `ask` (the security control: an injected "drop the
 *    database / delete prod data" that slips past the keyword rules still parks here);
 *  - everything else → `proceed` (so the clean autonomous bugfix summary, which trips no always-ask
 *    keyword, is allowed to drive straight to a PR instead of conservatively over-parking).
 *
 * This mirrors how a real Haiku classifier resolves these cases, but with zero network — keeping the
 * autonomous-dispatch and the prompt-injection-parks behaviors fully deterministic.
 */
export class FakeClassifierLlm implements ClassifierLlm {
  async classify(input: {
    description: string;
    context?: string;
    recordSummary: string;
  }): Promise<{ verdict: 'ask' | 'proceed'; decisionClass?: string; reason: string } | undefined> {
    const text = `${input.description} ${input.context ?? ''}`.toLowerCase();
    if (/delete|drop|destroy|production|prod\b|database|wipe|truncate|irreversible/.test(text)) {
      return {
        verdict: 'ask',
        decisionClass: 'one_way_door',
        reason: '(e2e fake) destructive / one-way-door action — must ask a human first.',
      };
    }
    return {
      verdict: 'proceed',
      reason: '(e2e fake) internal/never-ask call — safe to proceed.',
    };
  }
}

/**
 * Fake `EngineRunner`. No real Claude/Codex SDK, no agent home, no real file writes — but it DOES write
 * one trivial file on every `execute` turn (via the provided cwd) so the fake git "commit" has a real
 * change to stage in `--live`-shaped flows; in default mode git is faked too, so the write is harmless.
 * Plan/review turns are read-only no-ops returning canned text.
 */
export class FakeEngineRunner {
  private readonly logger = new Logger('FakeEngineRunner');

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    this.logger.debug(`fake engine: ${args.engine} mode=${args.mode} cwd=${args.cwd}`);
    const sessionId = randomUUID().slice(0, 12);
    if (args.mode === 'plan') {
      return {
        result: '(e2e fake) plan turn complete.',
        planText: '1. Make the single documented change.',
        sessionId,
      };
    }
    if (args.mode === 'review') {
      return { result: '(e2e fake) review turn — no findings.', sessionId };
    }
    if (args.mode === 'investigate') {
      return {
        result:
          '(e2e fake) repo digest: TypeScript/NestJS service; tooling: pnpm test + typecheck.',
        sessionId,
      };
    }
    // execute — a deterministic no-op "did the work" report (git is faked, no real file needed offline).
    await args.toolBridge?.tools?.['complete_thread']?.({
      summary: '(e2e fake) completed the requested change.',
      verification: [
        {
          kind: 'test',
          command: 'pnpm test',
          exitCode: 0,
          outputTail: 'ok',
        },
      ],
    });
    return {
      result: '(e2e fake) execute turn complete — change applied.',
      sessionId,
    };
  }
}

/**
 * Fake `LocalGitService`. No real clone / worktree / commit / push — returns deterministic in-memory
 * handles so the driver + acceptance flow run fully in-process. `commitAll` always returns a synthetic
 * sha (so the pipeline treats the change as real); `hasChanges` is true once; `push`/`removeSandbox`
 * are no-ops. Threads calls so the harness can assert no real outward git op happened.
 */
export class FakeLocalGitService {
  private commitSeq = 0;
  readonly pushed: string[] = [];

  reposRoot(): string {
    return '/tmp/atlas-e2e-fake-repos';
  }

  async ensureRepo(input: {
    repoId: string;
    gitUrl: string;
    defaultBranch?: string;
    token?: string;
  }): Promise<ProjectRepo> {
    return {
      repoId: input.repoId,
      gitUrl: input.gitUrl,
      defaultBranch: input.defaultBranch ?? 'main',
      repoPath: `${this.reposRoot()}/${input.repoId}`,
      ...(input.token ? { token: input.token } : {}),
    };
  }

  async createFeatureSandbox(repo: ProjectRepo, branch: string): Promise<FeatureSandbox> {
    return {
      repoId: repo.repoId,
      branch,
      worktreePath: `${repo.repoPath}/.worktrees/${branch.replace(/[^a-z0-9_-]/gi, '-')}`,
      gitUrl: repo.gitUrl,
      ...(repo.token ? { token: repo.token } : {}),
    };
  }

  /** Per-thread base worktree (what `JobLifecycleService.provisionSandbox` cuts at thread create). */
  async createBaseWorktree(repo: ProjectRepo, jobId: string): Promise<FeatureSandbox> {
    return {
      repoId: repo.repoId,
      branch: repo.defaultBranch,
      worktreePath: `${repo.repoPath}/.worktrees/thread-${jobId}`,
      gitUrl: repo.gitUrl,
      ...(repo.token ? { token: repo.token } : {}),
    };
  }

  /** Switch the worktree to the thread's feature branch (no real git — just relabels the handle). */
  async switchBranch(
    sandbox: FeatureSandbox,
    _repo: ProjectRepo,
    branch: string,
  ): Promise<FeatureSandbox> {
    return { ...sandbox, branch };
  }

  async refExists(): Promise<boolean> {
    return true;
  }

  async currentBranch(): Promise<string | null> {
    return null;
  }

  /** Provision-path no-ops (real impls touch git/cache/submodules; nothing to do in the fake). The fake
   *  repo never carries a `.gitmodules`, so it always takes the plain-worktree path, never full-clone. */
  async hasSubmodules(): Promise<boolean> {
    return false;
  }

  async createBaseClone(repo: ProjectRepo, jobId: string): Promise<FeatureSandbox> {
    return this.createBaseWorktree(repo, jobId);
  }

  async ensureSubmodules(): Promise<void> {
    // no-op
  }

  /** In the fake world every hydrated path is treated as gitignored (no real index to consult). */
  async isIgnored(): Promise<boolean> {
    return true;
  }

  /**
   * Writers own their commits now — a well-behaved writer turn leaves a CLEAN tree, so the fake reports
   * clean (the driver's `ensureCommitted` nudge would otherwise loop). `headSha` advances each call to model
   * the writer having committed, so the host stamps a fresh `commit_sha` per thread (HEAD != sectionStartSha).
   */
  async hasChanges(): Promise<boolean> {
    return false;
  }

  /** Pre-ship leak-scan — the fake worktree never carries hydrated secrets, so always clean. */
  async scanBranchForForbidden(): Promise<string[]> {
    return [];
  }

  /** Fast-path host commit (direct-build/onboarding ship) — synthetic sha; advances HEAD too. */
  async commitAll(): Promise<string | null> {
    this.commitSeq += 1;
    return `fakesha${String(this.commitSeq).padStart(8, '0')}`;
  }

  async push(sandbox: FeatureSandbox): Promise<void> {
    this.pushed.push(sandbox.branch);
  }

  async removeSandbox(): Promise<void> {
    // no-op
  }

  async headSha(): Promise<string> {
    // Advance on every read so successive host reads (thread start vs post-writer) see distinct shas —
    // modelling the in-sandbox writer having committed between them.
    this.commitSeq += 1;
    return `fakehead${String(this.commitSeq).padStart(7, '0')}`;
  }

  async listWorktrees(): Promise<string[]> {
    return [];
  }
}

/**
 * Fake `GithubPrService`. No network — returns a deterministic synthetic PR url so the driver records a
 * `pr_ready` and posts "PR ready" in-thread, without ever calling GitHub. Records opened PRs so the
 * harness can assert exactly one was "opened" per feature.
 */
export class FakeGithubPrService {
  private prSeq = 0;
  private readonly byHead = new Map<string, { url: string; number: number }>();
  readonly opened: Array<{ args: OpenPullRequestArgs; url: string }> = [];

  async openPullRequest(_token: string, args: OpenPullRequestArgs): Promise<PullRequestResult> {
    this.prSeq += 1;
    const url = `https://github.com/${args.owner}/${args.repo}/pull/${9000 + this.prSeq}`;
    this.opened.push({ args, url });
    return { url, number: 9000 + this.prSeq, existing: false };
  }

  /**
   * Atlas opens the PR in-sandbox (the e2e engine stub doesn't call `report_pr_opened`), so `ship` confirms
   * it via head-branch discovery. Deterministic + idempotent PER head, so a re-ship finds the SAME PR and
   * `opened` stays at one entry per feature branch (mirroring "one PR per feature").
   */
  async findOpenPullByHead(
    _token: string,
    args: { owner: string; repo: string; head: string },
  ): Promise<{ url: string; number: number } | null> {
    let pr = this.byHead.get(args.head);
    if (!pr) {
      this.prSeq += 1;
      pr = {
        url: `https://github.com/${args.owner}/${args.repo}/pull/${9000 + this.prSeq}`,
        number: 9000 + this.prSeq,
      };
      this.byHead.set(args.head, pr);
      this.opened.push({
        args: {
          owner: args.owner,
          repo: args.repo,
          head: args.head,
        } as unknown as OpenPullRequestArgs,
        url: pr.url,
      });
    }
    return pr;
  }

  async markReadyForReview(): Promise<{ isDraft: boolean }> {
    return { isDraft: false };
  }

  async commentOnPullRequest(): Promise<void> {
    // no-op
  }

  async getRepo(): Promise<null> {
    return null;
  }
}

/**
 * A deterministic, OFFLINE thread titler — returns the source text unchanged instead of calling the title
 * model. Int/e2e tests boot the real AppModule, which provides the live `JobTitler` (a Haiku call);
 * override it with this so titling is network-free and titles stay equal to the input the test passed in.
 */
export class FakeThreadTitler {
  async titleFor(text: string): Promise<string> {
    return text;
  }
}
