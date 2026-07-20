import { ChatAnthropic } from '@langchain/anthropic';
import { Global, Module } from '@nestjs/common';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { JOB_TITLE_CHAIN, JobTitleChain, type JobTitleChainFactory } from './job-title.chain';
import { JobTitler } from './job-titler.service';

@Global()
@Module({
  providers: [
    JobTitler,
    {
      provide: JOB_TITLE_CHAIN,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver): JobTitleChainFactory => {
        const cache = new Map<string, ReturnType<typeof JobTitleChain.build>>();
        return async (orgId) => {
          const key = await creds.anthropicKey(orgId);
          if (!key) return undefined;
          let chain = cache.get(key);
          if (!chain) {
            chain = JobTitleChain.build(
              new ChatAnthropic({
                apiKey: key,
                model: JobTitleChain.MODEL,
                maxTokens: 32,
                temperature: 0.3,
              }),
            );
            cache.set(key, chain);
          }
          return chain;
        };
      },
    },
  ],
  exports: [JOB_TITLE_CHAIN, JobTitler],
})
export class TitlingModule {}
