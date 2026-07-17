/**
 * The Atlas v2 ONBOARDING layer — per-tenant credentials + the resolver seam (Step 0), the onboarding
 * service / channel binding (Step 1), and the onboarding surfaces (Step 3). Public surface only.
 */
export { CredentialNeedsReauthError, CredentialRefreshService } from './credential-refresh.service';
export { CredentialResolver } from './credential-resolver.service';
export {
  loadLegacyManifestFile,
  type LoadedManifest,
  type WorktreeManifest,
} from './legacy-worktree-manifest';
export { OnboardingModule } from './onboarding.module';
export {
  OnboardingService,
  slugifyRepo,
  type ConnectRepoArgs,
  type ConnectedRepo,
  type OnboardingStatus,
  type OnboardingStep,
  type OrgLifecycle,
  type ValidationResult,
} from './onboarding.service';
export { decryptSecret, encryptSecret, loadSecretsKey } from './secret-cipher';
export {
  TenantCredentialStore,
  type CredentialPresence,
  type TenantCredentialPatch,
  type TenantCredentials,
} from './tenant-credential.store';
export { WorkspaceConfigStore } from './workspace-config.store';
export { WorkspaceSecretFileStore, type WorkspaceSecretFileRef } from './workspace-secret.store';

// NOTE: this layer is now credentials-only. The Slack-facing onboarding edge (OAuth install,
// interactivity bridge, in-Slack card/modal) was removed when Atlas collapsed to the single web surface.
