import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { managedGitSkillDirHost } from './skill-store-paths';
import { buildSystemSkills, type SystemSkill } from './system-skill-registry';

export interface SystemSkillView extends SystemSkill {
  synced?: boolean;
}

@Injectable()
export class SystemSkillResolver {
  constructor(private readonly env: EnvService) {}

  list(): SystemSkillView[] {
    const root = this.env.get('SKILLS_ROOT');
    return buildSystemSkills().map((s) =>
      s.git
        ? {
            ...s,
            synced: existsSync(join(managedGitSkillDirHost(root, s.name), 'SKILL.md')),
          }
        : s,
    );
  }
}
