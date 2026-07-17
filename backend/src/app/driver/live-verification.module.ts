import { Global, Module } from '@nestjs/common';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import {
  AnthropicLiveVerificationJudge,
  LIVE_VERIFICATION_JUDGE,
} from './live-verification-judge';

/**
 * The ADR-0005 live-verification judge, bound in ONE @Global place so the brain's direct-build
 * `finalize_build` gate (`AgentSessionManager`) can inject the port without reaching into `DriverModule`
 * (house DI style: ports-as-tokens + a shared module, never a cross-module reach or `forwardRef`). The
 * driver's own build-thread path no longer runs a verification gate (`complete_thread` is the sole
 * done-signal), so only the live judge — consumed by the brain's direct-build path — is bound here.
 *
 * The adapter/chain is pure — the only dependency is `CredentialResolver` (from the @Global onboarding
 * module) for the per-org Anthropic key. Env-fallback + conservative defaults live inside the adapter.
 */
@Global()
@Module({
  providers: [
    {
      provide: LIVE_VERIFICATION_JUDGE,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver) =>
        new AnthropicLiveVerificationJudge((orgId) =>
          creds.anthropicKey(orgId),
        ),
    },
  ],
  exports: [LIVE_VERIFICATION_JUDGE],
})
export class LiveVerificationModule {}
