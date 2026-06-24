import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GitModule } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrgCredentialsEntity, RepoEntity, OrganizationEntity } from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { OrgCredentialsController } from './credentials.controller';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { RepoController } from './repo.controller';
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
      [OrgCredentialsEntity, OrganizationEntity, RepoEntity],
      DB_CONNECTION,
    ),
  ],
  controllers: [OrgCredentialsController, RepoController, OnboardingController],
  providers: [TenantCredentialStore, CredentialResolver, OnboardingService],
  exports: [TenantCredentialStore, CredentialResolver, OnboardingService],
})
export class OnboardingModule {}
