import { Logger } from '@nestjs/common';
import type { EngineRunResult, RunEngineArgs } from '@shared/engine';
import { randomUUID } from 'node:crypto';
import type { ClassifierLlm } from '../decision-gate/classifier-llm';
import { OpenPullRequestArgs, PullRequestResult } from '../git/github-pr.service';
import { FeatureSandbox, ProjectRepo } from '../git/local-git.service';


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

  async createBaseWorktree(repo: ProjectRepo, jobId: string): Promise<FeatureSandbox> {
    return {
      repoId: repo.repoId,
      branch: repo.defaultBranch,
      worktreePath: `${repo.repoPath}/.worktrees/thread-${jobId}`,
      gitUrl: repo.gitUrl,
      ...(repo.token ? { token: repo.token } : {}),
    };
  }

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

  async hasSubmodules(): Promise<boolean> {
    return false;
  }

  async createBaseClone(repo: ProjectRepo, jobId: string): Promise<FeatureSandbox> {
    return this.createBaseWorktree(repo, jobId);
  }

  async ensureSubmodules(): Promise<void> {
  }

  async isIgnored(): Promise<boolean> {
    return true;
  }

  async hasChanges(): Promise<boolean> {
    return false;
  }

  async scanBranchForForbidden(): Promise<string[]> {
    return [];
  }

  async commitAll(): Promise<string | null> {
    this.commitSeq += 1;
    return `fakesha${String(this.commitSeq).padStart(8, '0')}`;
  }

  async push(sandbox: FeatureSandbox): Promise<void> {
    this.pushed.push(sandbox.branch);
  }

  async removeSandbox(): Promise<void> {
  }

  async headSha(): Promise<string> {
    this.commitSeq += 1;
    return `fakehead${String(this.commitSeq).padStart(7, '0')}`;
  }

  async listWorktrees(): Promise<string[]> {
    return [];
  }
}

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
  }

  async getRepo(): Promise<null> {
    return null;
  }
}

export class FakeThreadTitler {
  async titleFor(text: string): Promise<string> {
    return text;
  }
}
