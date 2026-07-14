import { Global, Module } from '@nestjs/common';
import { WorkspaceProfileService } from './workspace-profile.service';
import { ProfileAwarenessService } from './profile-awareness.service';

/**
 * The Workspace Profile read-model layer. `WorkspaceProfileService` COMPOSES the per-dimension stores
 * (all exported by `@Global` modules — `OnboardingModule`, `McpModule`, `SkillsModule`, `ConventionsModule`)
 * into one snapshot the brain sees every turn. Holds no entities of its own; `@Global` so the brain
 * turn-assembly path injects it with zero import churn, exactly like `ConventionsModule` / `McpModule`.
 *
 * `ProfileAwarenessService` is the sibling install-awareness handler (Stage 1) — it also needs zero import
 * churn at its two thread-2 tool-map call sites, so it rides the same `@Global` module.
 */
@Global()
@Module({
  providers: [WorkspaceProfileService, ProfileAwarenessService],
  exports: [WorkspaceProfileService, ProfileAwarenessService],
})
export class WorkspaceProfileModule {}
