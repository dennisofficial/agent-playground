import { Injectable } from '@nestjs/common';
import { buildSystemSkills, type SystemSkill } from './system-skill-registry';

/**
 * Resolves the SYSTEM tier of skills — Atlas's own code-defined built-ins — for the console's Skills page.
 * The skills counterpart of `SystemMcpResolver`; unlike that one there's no live-signal gating (a managed
 * skill's files are either on disk or not — `SkillResolver.resolveForTurn`, the seam that actually attaches
 * them to a turn, checks that at compose time, not here). Read-only: never written through a store, no org
 * param needed — the list is the same for every org.
 */
@Injectable()
export class SystemSkillResolver {
  list(): SystemSkill[] {
    return buildSystemSkills();
  }
}
