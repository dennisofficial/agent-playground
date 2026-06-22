/**
 * The Atlas v2 ONBOARDING layer — per-tenant credentials + the resolver seam (Phase 0), the onboarding
 * service / channel binding (Phase 1), and the onboarding surfaces (Phase 3). Public surface only.
 */
export { OnboardingModule } from './onboarding.module';
export { CredentialResolver } from './credential-resolver.service';
export {
  OnboardingService,
  type OnboardingStatus,
  type OnboardingStep,
  type TeamLifecycle,
  type ValidationResult,
  type BindChannelArgs,
} from './onboarding.service';
export {
  TenantCredentialStore,
  type TenantCredentials,
  type TenantCredentialPatch,
  type CredentialPresence,
} from './tenant-credential.store';
export { encryptSecret, decryptSecret, loadSecretsKey } from './secret-cipher';
export { engineAuthFromEnv } from './env-engine-auth';

// NOTE: this layer is now credentials-only. The Slack-facing onboarding edge (OAuth install,
// interactivity bridge, in-Slack card/modal) was removed when Atlas collapsed to the single web surface.
