import { CreateModule } from '@workspace/nestjs-core';
import { SkillLoaderService } from './skill-loader.service';

/**
 * Skills & MCP scaffold. Employees declare `skills: SkillSource[]` and `mcpServers` in their
 * definitions; this module will bootstrap them locally at startup (git clone/sync → validate
 * SKILL.md → hand dirs to the engines). The loader is a typed no-op for now.
 */
@CreateModule({
  services: [SkillLoaderService],
})
export class SkillsModule {}
