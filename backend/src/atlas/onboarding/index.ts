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

// NOTE: the Slack-facing pieces (OnboardingSlackService, SlackInteractivityBridge, SlackOAuthController,
// OnboardingSurfaceModule) are deliberately NOT re-exported here — they depend on ../brain and ../surface,
// and re-exporting them from this barrel (which ../brain imports for CredentialResolver) creates a cycle.
// Import them from their own files (app.module does so for OnboardingSurfaceModule).
