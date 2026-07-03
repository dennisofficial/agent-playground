import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GitModule } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  OrganizationEntity,
  OrgCredentialsEntity,
  OrgWorktreeSecretEntity,
  OrgWorktreeSecretGrantEntity,
  OrgWorktreeMountEntity,
  RepoEntity,
  StimulusEntity,
  JobEntity,
  JobSandboxEntity,
} from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { OrgCredentialsController } from './credentials.controller';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { RepoController } from './repo.controller';
import { TenantCredentialStore } from './tenant-credential.store';
import { WorktreeSecretStore } from './worktree-secret.store';
import { WorktreeConfigStore } from './worktree-config.store';
import { WorktreeSecretsController } from './worktree-secrets.controller';

/**
 * The ONBOARDING layer — the per-tenant credential store + the `CredentialResolver` seam every other
 * module reads through. `@Global` (like `SurfaceModule`/`DriverModule`) so the brain/driver/memory LLM
 * factories inject `CredentialResolver` with zero per-module import churn. Imported EARLY in the app
 * composition root so the global provider exists when those factories instantiate.
 *
 * Step 1 adds `OnboardingService` (channel binding + checklist) here; Step 2/3 add the Slack
 * installation store + the onboarding surfaces.
 */
@Global()
@Module({
  imports: [
    GitModule,
    TypeOrmModule.forFeature(
      [
        OrgCredentialsEntity,
        OrgWorktreeSecretEntity,
        OrgWorktreeSecretGrantEntity,
        OrgWorktreeMountEntity,
        OrganizationEntity,
        RepoEntity,
        JobEntity,
        StimulusEntity,
        DecisionRecordEntity,
        JobSandboxEntity,
      ],
      DB_CONNECTION,
    ),
  ],
  controllers: [
    OrgCredentialsController,
    WorktreeSecretsController,
    RepoController,
    OnboardingController,
  ],
  providers: [
    TenantCredentialStore,
    WorktreeSecretStore,
    WorktreeConfigStore,
    CredentialResolver,
    OnboardingService,
  ],
  exports: [
    TenantCredentialStore,
    WorktreeSecretStore,
    WorktreeConfigStore,
    CredentialResolver,
    OnboardingService,
  ],
})
export class OnboardingModule {}
