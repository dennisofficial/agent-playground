import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { repoRoot, skillCacheDir } from '../engines/engine-home';
import type { LoadedSkill, SkillSource } from './skill.types';

const execFileAsync = promisify(execFile);

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

/** Skip a redundant network `git fetch` when the same repo was synced this recently. A single boot
 * fans out across every employee, and skills are commonly subPaths of a FEW shared repos — without
 * this each employee re-fetches the same repo (the bulk of the old multi-second boot stall). */
const FETCH_TTL_MS = 5 * 60_000;

/**
 * Resolves an employee's declared `SkillSource`s to local skill DIRECTORIES (each holding a
 * SKILL.md), ready to hand to the engines. Git sources clone/sync ONCE into a shared, durable cache
 * (`<AGENT_HOME_ROOT>/.skill-cache`) and are then symlinked into each employee's home by the
 * provisioner; local sources are validated in place. Resilient by design: a source that fails to
 * clone or whose SKILL.md won't parse is warned and SKIPPED — a bad skill must not fail boot.
 *
 * Fully ASYNC + non-blocking: git runs via `execFile` (NOT `execFileSync`) and fs via `fs/promises`.
 * The old synchronous version monopolized the event loop for the whole provisioning pass, which
 * dropped the Slack socket (missed heartbeats) and timed out in-flight Postgres connections at boot.
 */
@Injectable()
export class SkillLoaderService {
  private readonly logger = new Logger(SkillLoaderService.name);
  /** Per-repo dedup + serialization: one in-flight sync per cache dir, so employees resolving the
   * same git skill concurrently await the SAME sync instead of racing the shared working tree. */
  private readonly repoSyncs = new Map<string, Promise<void>>();
  /** When each cache dir last completed a network fetch — drives the {@link FETCH_TTL_MS} skip. */
  private readonly fetchedAt = new Map<string, number>();

  constructor(private readonly env: EnvService) {}

  async resolve(sources: ReadonlyArray<SkillSource>): Promise<LoadedSkill[]> {
    const out: LoadedSkill[] = [];
    for (const source of sources) {
      try {
        const dir =
          source.kind === 'git'
            ? await this.syncGit(source)
            : await this.resolveLocal(source.path);
        const meta = await this.readSkillMeta(dir);
        out.push({
          name: meta.name,
          description: meta.description,
          dir,
          source,
        });
      } catch (err) {
        this.logger.warn(
          `Skipping skill source (${JSON.stringify(source)}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  /** Clone (first time) or fetch+checkout (subsequent) a git skill into the shared cache; return the
   * skill directory (the optional subPath into a multi-skill repo). */
  private async syncGit(
    source: Extract<SkillSource, { kind: 'git' }>,
  ): Promise<string> {
    const cache = skillCacheDir(this.env.get('AGENT_HOME_ROOT'));
    const key = createHash('sha1')
      .update(source.url)
      .digest('hex')
      .slice(0, 12);
    const repoDir = join(cache, key);
    await this.syncRepo(repoDir, source);
    const dir = source.subPath ? join(repoDir, source.subPath) : repoDir;
    if (!(await exists(dir)))
      throw new Error(`subPath "${source.subPath}" not found in ${source.url}`);
    return dir;
  }

  /** Run the repo's clone/fetch/checkout, SERIALIZED + DEDUPED per cache dir: the first caller runs
   * it; concurrent callers await the same promise. Dedup is keyed by cache dir (≡ url), so the many
   * skills that share one repo at one ref trigger a single sync. (One cache dir holds one ref at a
   * time — concurrent callers wanting DIFFERENT refs of the same url is unsupported, as it was in the
   * synchronous version; in practice every skill from a repo pins the same ref.) */
  private syncRepo(
    repoDir: string,
    source: Extract<SkillSource, { kind: 'git' }>,
  ): Promise<void> {
    const inFlight = this.repoSyncs.get(repoDir);
    if (inFlight) return inFlight;
    const run = this.doSyncRepo(repoDir, source).finally(() =>
      this.repoSyncs.delete(repoDir),
    );
    this.repoSyncs.set(repoDir, run);
    return run;
  }

  private async doSyncRepo(
    repoDir: string,
    source: Extract<SkillSource, { kind: 'git' }>,
  ): Promise<void> {
    if (!(await exists(join(repoDir, '.git')))) {
      await execFileAsync('git', [
        'clone',
        '--depth',
        '1',
        source.url,
        repoDir,
      ]);
      this.fetchedAt.set(repoDir, Date.now());
    } else if (Date.now() - (this.fetchedAt.get(repoDir) ?? 0) > FETCH_TTL_MS) {
      await execFileAsync(
        'git',
        ['fetch', '--depth', '1', 'origin', source.ref ?? 'HEAD'],
        { cwd: repoDir },
      );
      this.fetchedAt.set(repoDir, Date.now());
    }
    if (source.ref)
      await execFileAsync('git', ['checkout', '--force', source.ref], {
        cwd: repoDir,
      });
  }

  /** An absolute path, or a path resolved against the REPO ROOT (not cwd) — so the canonical
   * top-level `skills/<name>` dir is found no matter which app's working directory boots the harness
   * (the api app runs from a different cwd than the tui). */
  private async resolveLocal(path: string): Promise<string> {
    const dir = isAbsolute(path) ? path : resolve(repoRoot(), path);
    if (!(await exists(dir)))
      throw new Error(`local skill path does not exist: ${dir}`);
    return dir;
  }

  /** Pull `name` + `description` from the SKILL.md YAML frontmatter (the only fields we need). */
  private async readSkillMeta(
    dir: string,
  ): Promise<{ name: string; description: string }> {
    const file = join(dir, 'SKILL.md');
    if (!(await exists(file))) throw new Error(`no SKILL.md in ${dir}`);
    const text = await readFile(file, 'utf8');
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
    if (!fm) throw new Error(`SKILL.md in ${dir} has no frontmatter`);
    const field = (key: string): string | undefined =>
      new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm')
        .exec(fm[1])?.[1]
        ?.replace(/^['"]|['"]$/g, '');
    const name = field('name');
    if (!name)
      throw new Error(`SKILL.md in ${dir} has no "name" in frontmatter`);
    return { name, description: field('description') ?? '' };
  }
}
