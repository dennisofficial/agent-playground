import type { SkillSource } from '../skills/skill.types';

/** A runtime-granted skill row (the GLOBAL tier — `team_id IS NULL`). The provisioner unions these
 * with each employee's code-declared `skills` so a skill added here loads with no code change. */
export interface EmployeeSkillRecord {
  id: number;
  employeeId: string;
  /** A human label for the admin listing. The materialized skill's real name comes from its
   * SKILL.md (the loader resolves `source`), so this is display-only. */
  name: string;
  description: string;
  /** The `SkillSource` the loader resolves (git/local). */
  source: SkillSource;
}

/** What the admin supplies to grant a skill. */
export interface NewEmployeeSkill {
  employeeId: string;
  name: string;
  description?: string;
  source: SkillSource;
}
