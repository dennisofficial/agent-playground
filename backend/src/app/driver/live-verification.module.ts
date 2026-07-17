import { Global, Module } from '@nestjs/common';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { AnthropicLiveVerificationJudge, LIVE_VERIFICATION_JUDGE } from './live-verification-judge';

@Global()
@Module({
  providers: [
    {
      provide: LIVE_VERIFICATION_JUDGE,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver) =>
        new AnthropicLiveVerificationJudge((orgId) => creds.anthropicKey(orgId)),
    },
  ],
  exports: [LIVE_VERIFICATION_JUDGE],
})
export class LiveVerificationModule {}
