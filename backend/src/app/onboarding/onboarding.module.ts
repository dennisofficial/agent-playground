import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AUTH_REFRESH_SINK } from '../engine/auth-refresh.port';
import { GitModule } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  OrganizationEntity,
  OrgCredentialsEntity,
  OrgWorkspaceSecretFileEntity,
  OrgWorkspaceMountEntity,
  RepoEntity,
  StimulusEntity,
  JobEntity,
  JobSandboxEntity,
} from '../persistence/entities';
import { AuthRefreshSinkService } from './auth-refresh.sink';
import { CredentialResolver } from './credential-resolver.service';
import { OrgCredentialsController } from './credentials.controller';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { RepoController } from './repo.controller';
import { TenantCredentialStore } from './tenant-credential.store';
import { WorkspaceSecretFileStore } from './workspace-secret.store';
import { WorkspaceConfigStore } from './workspace-config.store';
import { WorkspaceSecretsController } from './workspace-secrets.controller';

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
        OrgWorkspaceSecretFileEntity,
        OrgWorkspaceMountEntity,
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
    WorkspaceSecretsController,
    RepoController,
    OnboardingController,
  ],
  providers: [
    TenantCredentialStore,
    WorkspaceSecretFileStore,
    WorkspaceConfigStore,
    CredentialResolver,
    OnboardingService,
    AuthRefreshSinkService,
    { provide: AUTH_REFRESH_SINK, useExisting: AuthRefreshSinkService },
  ],
  exports: [
    TenantCredentialStore,
    WorkspaceSecretFileStore,
    WorkspaceConfigStore,
    CredentialResolver,
    OnboardingService,
    AUTH_REFRESH_SINK,
  ],
})
export class OnboardingModule {}
