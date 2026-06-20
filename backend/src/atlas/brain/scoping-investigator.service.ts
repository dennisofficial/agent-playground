import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { SessionMode } from '../domain';
import { EngineRunner } from '../engine';
import { LocalGitService, type ProjectRepo } from '../git';
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

  private async investigate(input: ScopingInvestigateInput): Promise<string> {
    const repo = await this.resolveRepo(input.teamId, input.projectId);
    if (!repo) {
      this.logger.debug(`no atlas_projects repo for ${input.teamId}/${input.projectId} — no digest`);
      return '';
    }

    const mode = this.scopingMode();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      const result = await this.engine.run({
        engine: 'claude',
        task: renderInvestigateTask(input.focus),
        cwd: repo.repoPath,
        systemPrompt: SCOPING_INVESTIGATE_SYSTEM,
        sandboxKey: `scope-${input.projectId}`,
        mode,
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
    const token = this.env.get('ATLAS_GITHUB_TOKEN') ?? this.env.get('GITHUB_TOKEN');
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
