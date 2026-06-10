import { Injectable, Logger } from '@nestjs/common';
import type { LoadedSkill, SkillSource } from './skill.types';

/**
 * No-op skill loader — the interface is real, the behavior lands in a later pass.
 *
 * The real impl will, on application bootstrap: clone/sync `git` sources into a local cache dir,
 * validate each directory's SKILL.md, and memoize the resolved `LoadedSkill`s so `resolve()` is a
 * cheap lookup by the time engines ask for an employee's skills.
 */
@Injectable()
export class SkillLoaderService {
  private readonly logger = new Logger(SkillLoaderService.name);

  /** Resolve an employee's declared skill sources to local skill directories. Stub: resolves none. */
  async resolve(sources: ReadonlyArray<SkillSource>): Promise<LoadedSkill[]> {
    if (sources.length > 0) {
      this.logger.warn(
        `Skill loading not implemented yet — ignoring ${sources.length} declared skill source(s)`,
      );
    }
    return [];
  }
}
