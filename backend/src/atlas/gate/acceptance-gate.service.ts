import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../engine';
import {
  GithubPrService,
  LocalGitService,
  parseGithubRepoUrl,
  type FeatureSandbox,
} from '../git';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox';

/** Everything the live gate needs, resolved from env (with explicit overrides for a scripted run). */
export interface GateConfig {
  /** HTTPS GitHub URL of the repo to run against (the gate clones it, cuts a worktree, opens a PR). */
  gitUrl: string;
  /** PR base branch (default: the repo's detected default). */
  baseBranch?: string;
  /** When true, BUILD + run the local steps but DO NOT open a PR (offline proof). */
  dryRun: boolean;
  /** Which engine to drive the one local turn with. */
  engine?: 'claude' | 'codex';
}

export interface GateResult {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
  /** The opened PR url, when not dry-run. */
  prUrl?: string;
}

/**
 * THE W1 ACCEPTANCE GATE — the single proof that the host-only substrate works end-to-end without a
 * daemon, without v1's SessionRunner / ReviewPipeline:
 *   1. run one ENGINE turn in a fresh local worktree;
 *   2. make a trivial change + COMMIT it;
 *   3. open a real PR.
 *
 * The outward-facing step (3) is GATED behind `dryRun`: in dry-run it is built + exercised up to the
 * network boundary but not fired (the live gate runs against a Dennis-chosen repo). The engine turn +
 * commit are always local + safe. Surface-free (no chat posting).
 */
@Injectable()
export class AcceptanceGateService {
  private readonly logger = new Logger(AcceptanceGateService.name);

  constructor(
    private readonly env: EnvService,
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxes: SandboxProvider,
  ) {}

  private githubToken(): string | undefined {
    return this.env.get('ATLAS_GITHUB_TOKEN') ?? this.env.get('GITHUB_TOKEN');
  }

  async run(config: GateConfig): Promise<GateResult> {
    const steps: GateResult['steps'] = [];
    const record = (name: string, ok: boolean, detail: string) => {
      steps.push({ name, ok, detail });
      this.logger[ok ? 'log' : 'error'](`[gate] ${name}: ${ok ? 'OK' : 'FAIL'} — ${detail}`);
    };

    const runId = randomUUID().slice(0, 8);
    const branch = `atlas/gate-${runId}`;
    const token = this.githubToken();
    const parsed = parseGithubRepoUrl(config.gitUrl);
    if (!parsed) {
      record('config', false, `not an HTTPS GitHub URL: ${config.gitUrl}`);
      return { ok: false, steps };
    }

    let sandbox: FeatureSandbox | undefined;
    let repoPath: string | undefined;
    try {
      // ── 1. Clone/locate + cut a fresh worktree ────────────────────────────────────────────────
      const repo = await this.git.ensureRepo({
        projectId: `${parsed.owner}-${parsed.repo}`,
        gitUrl: config.gitUrl,
        ...(config.baseBranch ? { defaultBranch: config.baseBranch } : {}),
        ...(token ? { token } : {}),
      });
      repoPath = repo.repoPath;
      record('clone', true, `repo at ${repo.repoPath} (base ${repo.defaultBranch})`);
      sandbox = await this.git.createFeatureSandbox(repo, branch);
      // Attach the execution environment (no-op in local mode; a container in docker mode).
      sandbox = await this.sandboxes.attach({ sandbox, teamId: 'gate' });
      record('worktree', true, `${sandbox.worktreePath} on ${branch}${sandbox.containerId ? ' (sandboxed)' : ''}`);

      // ── 2. Run one ENGINE turn in the worktree (execute mode → it makes the trivial change) ────
      const engine = config.engine ?? 'claude';
      const turn = await this.engine.run({
        engine,
        mode: 'execute',
        cwd: sandbox.worktreePath,
        sandboxKey: `${repo.projectId}--${branch}`,
        ...(sandbox.containerId
          ? {
              target: {
                containerId: sandbox.containerId,
                ...(sandbox.execUser ? { user: sandbox.execUser } : {}),
              },
            }
          : {}),
        systemPrompt:
          'You are an automation worker validating a pipeline. Do exactly what the task asks, nothing more.',
        task:
          `Create or append a single line to a file named ATLAS_GATE.md in the repo root: ` +
          `"Atlas v2 acceptance gate ${runId} — ${new Date().toISOString()}". ` +
          `Do not touch any other file. Then stop.`,
        onEvent: (e) => {
          if (e.kind === 'tool') this.logger.debug(`[gate] engine tool: ${e.name}`);
        },
      });
      record('engine-turn', true, `engine=${engine} session=${turn.sessionId ?? '-'}`);

      // ── 3. Commit the change ──────────────────────────────────────────────────────────────────
      const changed = await this.git.hasChanges(sandbox.worktreePath);
      const sha = await this.git.commitAll(
        sandbox.worktreePath,
        `chore: atlas v2 acceptance gate ${runId}`,
      );
      record('commit', !!sha, sha ? `committed ${sha.slice(0, 8)}` : `nothing to commit (changed=${changed})`);
      if (!sha) {
        // The engine produced no change — fail the gate (the path is unproven).
        return { ok: false, steps };
      }

      // ── 4. Push + open a real PR ───────────────────────────────────────────────────────────────
      let prUrl: string | undefined;
      if (config.dryRun) {
        record(
          'pull-request',
          !!token,
          token
            ? 'DRY-RUN: token present; would push + open PR (skipped)'
            : 'DRY-RUN: no GitHub token — set ATLAS_GITHUB_TOKEN for the live gate',
        );
      } else {
        if (!token) {
          record('pull-request', false, 'no GitHub token (ATLAS_GITHUB_TOKEN/GITHUB_TOKEN)');
          return { ok: false, steps };
        }
        await this.git.push(sandbox);
        const opened = await this.pr.openPullRequest(token, {
          owner: parsed.owner,
          repo: parsed.repo,
          head: branch,
          base: config.baseBranch ?? repo.defaultBranch,
          title: `Atlas v2 acceptance gate ${runId}`,
          body: 'Automated W1 acceptance-gate PR — proves the host-only engine→git→PR path.',
          draft: true,
        });
        prUrl = opened.url;
        record('pull-request', true, `${opened.existing ? 'existing' : 'opened'} ${opened.url}`);
      }

      const ok = steps.every((s) => s.ok);
      return {
        ok,
        steps,
        ...(prUrl ? { prUrl } : {}),
      };
    } catch (err) {
      record('error', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
      return { ok: false, steps };
    } finally {
      // Leave the worktree in place on the live gate (the PR references the branch); clean up only
      // the throwaway dry-run worktree to avoid disk leak.
      if (config.dryRun && sandbox && repoPath) {
        await this.git
          .removeSandbox(
            {
              projectId: `${parsed.owner}-${parsed.repo}`,
              gitUrl: config.gitUrl,
              defaultBranch: config.baseBranch ?? 'main',
              repoPath,
            },
            sandbox.worktreePath,
          )
          .catch(() => undefined);
      }
    }
  }
}
