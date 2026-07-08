import { Global, Module } from '@nestjs/common';
import { WorkspaceProfileService } from './workspace-profile.service';

/**
 * The Workspace Profile read-model layer. `WorkspaceProfileService` COMPOSES the per-dimension stores
 * (all exported by `@Global` modules — `OnboardingModule`, `McpModule`, `SkillsModule`, `ConventionsModule`)
 * into one snapshot the brain sees every turn. Holds no entities of its own; `@Global` so the brain
 * turn-assembly path injects it with zero import churn, exactly like `ConventionsModule` / `McpModule`.
 */
@Global()
@Module({
  providers: [WorkspaceProfileService],
  exports: [WorkspaceProfileService],
})
export class WorkspaceProfileModule {}
