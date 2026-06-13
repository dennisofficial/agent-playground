import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { skillCacheDir } from '../engines/engine-home';
import type { LoadedSkill, SkillSource } from './skill.types';

/**
 * Resolves an employee's declared `SkillSource`s to local skill DIRECTORIES (each holding a
 * SKILL.md), ready to hand to the engines. Git sources clone/sync ONCE into a shared, durable cache
 * (`<AGENT_HOME_ROOT>/.skill-cache`) and are then symlinked into each employee's home by the
 * provisioner; local sources are validated in place. Resilient by design: a source that fails to
 * clone or whose SKILL.md won't parse is warned and SKIPPED — a bad skill must not fail boot.
 */
@Injectable()
export class SkillLoaderService {
  private readonly logger = new Logger(SkillLoaderService.name);

  constructor(private readonly env: EnvService) {}

  // Sync internally (git via execFileSync), but the port is async so a future network-backed loader
  // can swap in without touching callers.
  resolve(sources: ReadonlyArray<SkillSource>): Promise<LoadedSkill[]> {
    const out: LoadedSkill[] = [];
    for (const source of sources) {
      try {
        const dir =
          source.kind === 'git'
            ? this.syncGit(source)
            : this.resolveLocal(source.path);
        const meta = this.readSkillMeta(dir);
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
    return Promise.resolve(out);
  }

  /** Clone (first time) or fetch+checkout (subsequent) a git skill into the shared cache; return the
   * skill directory (the optional subPath into a multi-skill repo). */
  private syncGit(source: Extract<SkillSource, { kind: 'git' }>): string {
    const cache = skillCacheDir(this.env.get('AGENT_HOME_ROOT'));
    const key = createHash('sha1')
      .update(source.url)
      .digest('hex')
      .slice(0, 12);
    const repoDir = join(cache, key);
    if (!existsSync(join(repoDir, '.git'))) {
      execFileSync('git', ['clone', '--depth', '1', source.url, repoDir], {
        stdio: 'pipe',
      });
    } else {
      execFileSync(
        'git',
        ['fetch', '--depth', '1', 'origin', source.ref ?? 'HEAD'],
        {
          cwd: repoDir,
          stdio: 'pipe',
        },
      );
    }
    if (source.ref) {
      execFileSync('git', ['checkout', '--force', source.ref], {
        cwd: repoDir,
        stdio: 'pipe',
      });
    }
    const dir = source.subPath ? join(repoDir, source.subPath) : repoDir;
    if (!existsSync(dir))
      throw new Error(`subPath "${source.subPath}" not found in ${source.url}`);
    return dir;
  }

  /** An absolute path, or a path resolved against the process cwd (repo). */
  private resolveLocal(path: string): string {
    const dir = isAbsolute(path) ? path : resolve(process.cwd(), path);
    if (!existsSync(dir))
      throw new Error(`local skill path does not exist: ${dir}`);
    return dir;
  }

  /** Pull `name` + `description` from the SKILL.md YAML frontmatter (the only fields we need). */
  private readSkillMeta(dir: string): { name: string; description: string } {
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) throw new Error(`no SKILL.md in ${dir}`);
    const text = readFileSync(file, 'utf8');
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
