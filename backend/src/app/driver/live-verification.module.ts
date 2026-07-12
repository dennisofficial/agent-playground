import { Global, Module } from '@nestjs/common';
import { CredentialResolver } from '../onboarding';
import {
  AnthropicLiveVerificationJudge,
  LIVE_VERIFICATION_JUDGE,
} from './live-verification-judge';
import {
  AnthropicStaticVerificationJudge,
  STATIC_VERIFICATION_JUDGE,
} from './static-verification-judge';

/**
 * The ADR-0005 live-verification judge, bound in ONE @Global place so BOTH gate callers inject the same
 * port: the driver's per-thread `complete_thread` gate (`ThreadDriver`) and the brain's direct-build
 * `finalize_build` gate (`AgentSessionManager`). Formerly a driver-private binding; lifted here so the
 * brain can consume it without reaching into `DriverModule` (house DI style: ports-as-tokens + a shared
 * module, never a cross-module reach or `forwardRef`).
 *
 * Its SIBLING, the static-verification judge, is bound here too — the driver's `complete_thread` gate injects
 * BOTH (static checks + live e2e), replacing the eliminated Opus session-resume diagnostics gate. The brain's
 * direct-build gate consumes only the live judge (its static-check surface is out of scope for this change).
 *
 * The adapters/chains are pure — the only dependency is `CredentialResolver` (from the @Global onboarding
 * module) for the per-org Anthropic key. Env-fallback + conservative defaults live inside the adapters.
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
    {
      provide: STATIC_VERIFICATION_JUDGE,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver) =>
        new AnthropicStaticVerificationJudge((orgId) =>
          creds.anthropicKey(orgId),
        ),
    },
  ],
  exports: [LIVE_VERIFICATION_JUDGE, STATIC_VERIFICATION_JUDGE],
})
export class LiveVerificationModule {}
