import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { SessionMode } from '../domain';
import { EngineRunner } from '../engine';
import { LocalGitService, type ProjectRepo } from '../git';
import { CredentialResolver } from '../onboarding';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasProject } from '../persistence/entities';

/** What one scoping investigation needs: the project to read + the operator's request to ground on. */
export interface ScopingInvestigateInput {
  teamId: string;
  projectId: string;
  /** Cache key — one digest per scoping thread (re-derivable on miss). */
  threadId: string;
  /** The operator's request, so the digest is grounded on what they actually asked about. */
  focus: string;
}

/** The strict read-only posture for scoping — Read/Glob/Grep, no Bash, no writes (see SessionMode). */
const SCOPING_INVESTIGATE_SYSTEM = [
  'You are Atlas investigating a repository to GROUND a scoping conversation — a READ-ONLY pass. Do not',
  'change anything; produce a concise brief of FACTS another Atlas turn will use to grill the operator',
  'WITHOUT asking them things the repo already answers.',
  '',
  'Read the actual repo (package manifests, config, the relevant source) and report, tightly:',
  '  - Stack & frameworks (languages, key libraries, runtime) — from the real manifests, not a guess.',
  '  - Tooling: the lint / typecheck / test / build commands that actually exist (scripts, configs).',
  '  - Structure: the top-level layout and the modules/areas relevant to the request.',
  '  - For the request specifically: which existing files/areas it touches, and whether the thing being',
  '    asked for already exists (in whole or part).',
  '  - Conventions the implementation should follow (how this codebase already does the relevant thing).',
  '',
  'Be FAST and FOCUSED — a short investigation, not an audit. Output a compact markdown digest (a few',
  'short sections / bullets). State only what you verified from files; if something is unknown, say so',
  'rather than inventing it. Do NOT propose a plan or ask questions — just the grounded digest.',
].join('\n');

/**
 * The W3-safe SCOPING INVESTIGATOR (issue #1). Before/while the brain grills, it runs ONE read-only
 * engine pass over the project's actual clone and returns a concise REPO DIGEST, so the grill grounds
 * its questions in real facts and stops interrogating the operator for things it could read (stack,
 * file existence, tooling). It reuses the minimal `EngineRunner` in a truly read-only posture
 * (`ATLAS_SCOPING_MODE=read_only_tools` → `investigate`, Read/Glob/Grep only, no Bash, run on the base
 * clone; `native_plan` → Claude's native plan mode). The digest is cached per thread (re-derivable on a
 * miss — not durable state). Fails SOFT to an empty string: no repo / no key / error → the brain grills
 * without it. Lives in the brain (W3) and resolves the repo itself (EnvService + LocalGitService +
 * atlas_projects) — no dependency on the driver (W4), so no module cycle. Zero v1 imports.
 */
@Injectable()
export class ScopingInvestigatorService {
  private readonly logger = new Logger(ScopingInvestigatorService.name);
  /** threadId → digest. In-memory cache (re-derivable), NOT durable session state. */
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly env: EnvService,
    private readonly engine: EngineRunner,
    private readonly git: LocalGitService,
    private readonly creds: CredentialResolver,
    @InjectRepository(AtlasProject, ATLAS_CONNECTION)
    private readonly projects: Repository<AtlasProject>,
  ) {}

  /** The grounded digest for a scoping thread (cached). '' when there's no repo / investigation fails. */
  async digest(input: ScopingInvestigateInput): Promise<string> {
    const cached = this.cache.get(input.threadId);
    if (cached !== undefined) return cached;
    const digest = await this.investigate(input).catch((err) => {
      this.logger.warn(`scoping investigation failed (grilling without a digest): ${err}`);
      return '';
    });
    this.cache.set(input.threadId, digest);
    return digest;
  }

  /** Drop a thread's cached digest once scoping resolves (dispatched / cancelled). */
  forget(threadId: string): void {
    this.cache.delete(threadId);
  }

  /**
   * Answer a non-work QUESTION about the repo (issue #6), grounded in a read-only pass over the actual
   * clone. Returns the answer prose, or '' when there's no repo / it fails (caller falls back). Not cached
   * — questions are one-off.
   */
  async answer(input: { teamId: string; projectId: string; question: string }): Promise<string> {
    return this.runReadonly(
      input.teamId,
      input.projectId,
      ANSWER_SYSTEM,
      renderAnswerTask(input.question),
      `answer-${input.projectId}`,
    ).catch((err) => {
      this.logger.warn(`answer investigation failed: ${err}`);
      return '';
    });
  }

  private async investigate(input: ScopingInvestigateInput): Promise<string> {
    return this.runReadonly(
      input.teamId,
      input.projectId,
      SCOPING_INVESTIGATE_SYSTEM,
      renderInvestigateTask(input.focus),
      `scope-${input.projectId}`,
    );
  }

  /** Resolve the repo, then run ONE read-only engine pass (strict `investigate` mode, or native `plan`
   *  per ATLAS_SCOPING_MODE) over its clone with a wall-clock budget; returns the turn's text ('' if no
   *  repo). The single seam both the digest and the answer lane go through. */
  private async runReadonly(
    teamId: string,
    projectId: string,
    systemPrompt: string,
    task: string,
    sandboxKey: string,
  ): Promise<string> {
    const repo = await this.resolveRepo(teamId, projectId);
    if (!repo) {
      this.logger.debug(`no atlas_projects repo for ${teamId}/${projectId} — read-only pass skipped`);
      return '';
    }
    const mode = this.scopingMode();
    const auth = await this.creds.engineAuth(teamId, 'claude');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      const result = await this.engine.run({
        engine: 'claude',
        task,
        cwd: repo.repoPath,
        systemPrompt,
        sandboxKey,
        mode,
        auth,
        signal: controller.signal,
      });
      // native_plan captures its substance as planText; investigate returns it as the result.
      return (result.planText ?? result.result ?? '').trim();
    } finally {
      clearTimeout(timer);
    }
  }

  /** `read_only_tools` (default) → strict read-only `investigate`; `native_plan` → Claude plan mode. */
  private scopingMode(): SessionMode {
    return this.env.get('ATLAS_SCOPING_MODE') === 'native_plan' ? 'plan' : 'investigate';
  }

  private timeoutMs(): number {
    const raw = Number(this.env.get('ATLAS_SCOPING_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
  }

  /** Resolve the project's clone read-only (no PR token needed for reading; pass it if present). */
  private async resolveRepo(teamId: string, projectId: string): Promise<ProjectRepo | null> {
    const project = await this.projects.findOne({
      where: { team_id: teamId, project_id: projectId },
    });
    if (!project) return null;
    const token = await this.creds.githubToken(teamId);
    return this.git.ensureRepo({
      projectId,
      gitUrl: project.git_url,
      defaultBranch: project.default_branch,
      ...(token ? { token } : {}),
    });
  }
}

/** The per-turn investigation instructions, grounded on the operator's request. */
function renderInvestigateTask(focus: string): string {
  return [
    'Investigate this repository to ground a scoping conversation about the following request:',
    '',
    `REQUEST: ${focus}`,
    '',
    'Produce the concise grounded digest described in your instructions. Read-only — change nothing.',
  ].join('\n');
}

/** System prompt for the answer lane (issue #6): answer the operator's question from the real repo. */
const ANSWER_SYSTEM = [
  'You are Atlas answering an operator\'s QUESTION about this repository — a READ-ONLY pass. Read the',
  'actual code/config needed and answer accurately and concisely, grounded in what the repo really',
  'contains (cite the concrete modules/files that matter). This is a conversational answer, NOT a plan',
  'and NOT a code change — do not modify anything and do not propose work unless asked. If the repo does',
  "not answer the question, say so plainly rather than guessing. Reply with the answer prose only.",
].join('\n');

/** The per-turn answer instructions. */
function renderAnswerTask(question: string): string {
  return [
    'Answer this question about the repository, grounded in the actual code:',
    '',
    `QUESTION: ${question}`,
    '',
    'Read what you need (read-only) and give a clear, concise, accurate answer.',
  ].join('\n');
}
