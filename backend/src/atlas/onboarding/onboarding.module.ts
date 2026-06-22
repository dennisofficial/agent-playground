import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GitModule } from '../git';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasChannel,
  AtlasProject,
  AtlasTeam,
  AtlasTenantCredentials,
} from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { OnboardingService } from './onboarding.service';
import { TenantCredentialStore } from './tenant-credential.store';

/**
 * The ONBOARDING layer — the per-tenant credential store + the `CredentialResolver` seam every other
 * module reads through. `@Global` (like `SurfaceModule`/`DriverModule`) so the brain/driver/memory LLM
 * factories inject `CredentialResolver` with zero per-module import churn. Imported EARLY in the app
 * composition root so the global provider exists when those factories instantiate.
 *
 * Phase 1 adds `OnboardingService` (channel binding + checklist) here; Phase 2/3 add the Slack
 * installation store + the onboarding surfaces.
 */
@Global()
@Module({
  imports: [
    GitModule,
    TypeOrmModule.forFeature(
      [AtlasTenantCredentials, AtlasTeam, AtlasProject, AtlasChannel],
      ATLAS_CONNECTION,
    ),
  ],
  providers: [TenantCredentialStore, CredentialResolver, OnboardingService],
  exports: [TenantCredentialStore, CredentialResolver, OnboardingService],
})
export class OnboardingModule {}
