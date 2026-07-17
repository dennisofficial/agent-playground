import { ChatAnthropic } from '@langchain/anthropic';
import { Global, Module } from '@nestjs/common';
import { CredentialResolver } from '../onboarding';
import { JOB_TITLE_CHAIN, JobTitleChain, type JobTitleChainFactory } from './job-title.chain';
import { JobTitler } from './job-titler.service';

/**
 * TITLING — the shared thread-titling capability, `@Global` so any domain module can inject `JobTitler`
 * without an import edge. Owns the per-org title-model chain factory (moved here from `WebSurfaceModule`):
 * resolve the tenant's Anthropic key (env fallback via `CredentialResolver`) and cache ONE declarative
 * chain per key; key-less → `undefined` (the titler degrades to its deterministic fallback).
 */
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
