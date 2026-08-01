import { CreateModule } from '@dltech/nestjs-core';
import { SkillsService } from './skills.service';

/**
 * Skills catalog (provisioning). Scaffold: the `SkillsService` the SandboxModule reads to mount
 * skills into a job's container. The Skill model is server-only (NO_CLIENT_ACCESS) and reached
 * through PrismaService once `listForRepo` grows a real implementation.
 */
@CreateModule({
  services: [SkillsService],
})
export class SkillsModule {}
