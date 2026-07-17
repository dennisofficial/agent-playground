import { Global, Module } from '@nestjs/common';
import { EnvService } from '@core/config/env/env.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { WorkspaceProfileService } from './workspace-profile.service';
import { ProfileAwarenessService } from './profile-awareness.service';
import {
  INSTALL_AWARENESS_FILTER,
  AnthropicInstallAwarenessFilter,
} from './install-awareness-filter';

/**
 * Stage 2 kill switch (decision d2). Set `INSTALL_AWARENESS_FILTER_DISABLED=on` to disable the Haiku
 * filter/enricher entirely — the `INSTALL_AWARENESS_FILTER` provider then resolves to `undefined`, and
 * `ProfileAwarenessService` falls through to the plain Stage-1 deterministic checklist for every nudge.
 */
export const INSTALL_AWARENESS_FILTER_DISABLED =
  'INSTALL_AWARENESS_FILTER_DISABLED';

/**
 * The Workspace Profile read-model layer. `WorkspaceProfileService` COMPOSES the per-dimension stores
 * (all exported by `@Global` modules — `OnboardingModule`, `McpModule`, `SkillsModule`, `ConventionsModule`)
 * into one snapshot the brain sees every turn. Holds no entities of its own; `@Global` so the brain
 * turn-assembly path injects it with zero import churn, exactly like `ConventionsModule` / `McpModule`.
 *
 * `ProfileAwarenessService` is the sibling install-awareness handler (Stage 1 + 2) — it also needs zero
 * import churn at its two thread-2 tool-map call sites, so it rides the same `@Global` module. The Stage-2
 * filter provider mirrors `decision-gate.module.ts`'s `CLASSIFIER_LLM` factory: a per-org Anthropic key via
 * the `@Global` `OnboardingModule`'s `CredentialResolver` (no explicit import needed), key-less → `undefined`.
 */
@Global()
@Module({
  providers: [
    WorkspaceProfileService,
    ProfileAwarenessService,
    {
      provide: INSTALL_AWARENESS_FILTER,
      inject: [CredentialResolver, EnvService],
      useFactory: (creds: CredentialResolver, env: EnvService) =>
        env.get(INSTALL_AWARENESS_FILTER_DISABLED) !== 'on'
          ? new AnthropicInstallAwarenessFilter((orgId) =>
              creds.anthropicKey(orgId),
            )
          : undefined,
    },
  ],
  exports: [
    WorkspaceProfileService,
    ProfileAwarenessService,
    INSTALL_AWARENESS_FILTER,
  ],
})
export class WorkspaceProfileModule {}
