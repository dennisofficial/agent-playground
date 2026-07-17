import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AUTH_REFRESH_SINK } from '@shared/engine/auth-refresh.port';
import { GitModule } from '../git/git.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  InboundMessageEntity,
  JobEntity,
  JobSandboxEntity,
  OrganizationEntity,
  OrgClaudeCredentialEntity,
  OrgCredentialsEntity,
  OrgWorkspaceMountEntity,
  OrgWorkspaceSecretFileEntity,
  RepoEntity,
} from '../persistence/entities';
import { AuthRefreshSinkService } from './auth-refresh.sink';
import { ClaudeCredentialStore } from './claude-credential.store';
import { ClaudeCredentialsController } from './claude-credentials.controller';
import { ClaudeOAuthPkceStore } from './claude-oauth-pkce.store';
import { CredentialKeepAliveService } from './credential-keepalive.service';
import { CredentialRefreshService } from './credential-refresh.service';
import { CredentialResolver } from './credential-resolver.service';
import { OrgCredentialsController } from './credentials.controller';
import { GithubAppStateStore } from './github-app-state.store';
import { GithubAppCallbackController, GithubAppController } from './github-app.controller';
import { OauthUsageService } from './oauth-usage.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { RepoController } from './repo.controller';
import { TenantCredentialStore } from './tenant-credential.store';
import { UsageEventBus } from './usage-event-bus';
import { OrgUsageController } from './usage.controller';
import { WorkspaceConfigStore } from './workspace-config.store';
import { WorkspaceProfileController } from './workspace-profile.controller';
import { WorkspaceSecretFileStore } from './workspace-secret.store';
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
        OrgClaudeCredentialEntity,
        OrgWorkspaceSecretFileEntity,
        OrgWorkspaceMountEntity,
        OrganizationEntity,
        RepoEntity,
        JobEntity,
        InboundMessageEntity,
        DecisionRecordEntity,
        JobSandboxEntity,
      ],
      DB_CONNECTION,
    ),
  ],
  controllers: [
    OrgCredentialsController,
    ClaudeCredentialsController,
    WorkspaceSecretsController,
    WorkspaceProfileController,
    RepoController,
    OnboardingController,
    OrgUsageController,
    GithubAppController,
    GithubAppCallbackController,
  ],
  providers: [
    TenantCredentialStore,
    ClaudeCredentialStore,
    ClaudeOAuthPkceStore,
    GithubAppStateStore,
    WorkspaceSecretFileStore,
    WorkspaceConfigStore,
    CredentialResolver,
    CredentialRefreshService,
    CredentialKeepAliveService,
    OnboardingService,
    AuthRefreshSinkService,
    { provide: AUTH_REFRESH_SINK, useExisting: AuthRefreshSinkService },
    OauthUsageService,
    UsageEventBus,
  ],
  exports: [
    TenantCredentialStore,
    ClaudeCredentialStore,
    WorkspaceSecretFileStore,
    WorkspaceConfigStore,
    CredentialResolver,
    CredentialRefreshService,
    OnboardingService,
    AUTH_REFRESH_SINK,
    OauthUsageService,
    UsageEventBus,
  ],
})
export class OnboardingModule {}
