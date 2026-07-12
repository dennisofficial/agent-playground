/**
 * The Atlas v2 ONBOARDING layer — per-tenant credentials + the resolver seam (Step 0), the onboarding
 * service / channel binding (Step 1), and the onboarding surfaces (Step 3). Public surface only.
 */
export { OnboardingModule } from './onboarding.module';
export { CredentialResolver } from './credential-resolver.service';
export {
  CredentialRefreshService,
  CredentialNeedsReauthError,
} from './credential-refresh.service';
export {
  OnboardingService,
  slugifyRepo,
  type OnboardingStatus,
  type OnboardingStep,
  type OrgLifecycle,
  type ValidationResult,
  type ConnectRepoArgs,
  type ConnectedRepo,
} from './onboarding.service';
export {
  TenantCredentialStore,
  type TenantCredentials,
  type TenantCredentialPatch,
  type CredentialPresence,
} from './tenant-credential.store';
export {
  WorkspaceSecretFileStore,
  type WorkspaceSecretFileRef,
} from './workspace-secret.store';
export { WorkspaceConfigStore } from './workspace-config.store';
export {
  loadLegacyManifestFile,
  type WorktreeManifest,
  type LoadedManifest,
} from './legacy-worktree-manifest';
export { encryptSecret, decryptSecret, loadSecretsKey } from './secret-cipher';

// NOTE: this layer is now credentials-only. The Slack-facing onboarding edge (OAuth install,
// interactivity bridge, in-Slack card/modal) was removed when Atlas collapsed to the single web surface.
