import { CreateModule } from '@workspace/nestjs-core';
import { Skill, SkillRepo } from '../../_lib/database/entities/skill.entity';
import { SkillsService } from './skills.service';

/**
 * Skills catalog (provisioning). Scaffold: the `skills` entity + `SkillsService` the future SandboxModule
 * reads to mount skills into a job's container.
 */
@CreateModule({
  entities: [{ entity: Skill, repoClass: SkillRepo }],
  services: [SkillsService],
})
export class SkillsModule {}
