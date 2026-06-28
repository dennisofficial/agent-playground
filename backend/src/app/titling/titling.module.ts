import { ChatAnthropic } from '@langchain/anthropic';
import { Global, Module } from '@nestjs/common';
import { CredentialResolver } from '../onboarding';
import {
  THREAD_TITLE_CHAIN,
  ThreadTitleChain,
  type ThreadTitleChainFactory,
} from './thread-title.chain';
import { ThreadTitler } from './thread-titler.service';

/**
 * TITLING — the shared thread-titling capability, `@Global` so any domain module can inject `ThreadTitler`
 * without an import edge. Owns the per-org title-model chain factory (moved here from `WebSurfaceModule`):
 * resolve the tenant's Anthropic key (env fallback via `CredentialResolver`) and cache ONE declarative
 * chain per key; key-less → `undefined` (the titler degrades to its deterministic fallback).
 */
@Global()
@Module({
  providers: [
    ThreadTitler,
    {
      provide: THREAD_TITLE_CHAIN,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver): ThreadTitleChainFactory => {
        const cache = new Map<string, ReturnType<typeof ThreadTitleChain.build>>();
        return async (orgId) => {
          const key = await creds.anthropicKey(orgId);
          if (!key) return undefined;
          let chain = cache.get(key);
          if (!chain) {
            chain = ThreadTitleChain.build(
              new ChatAnthropic({
                apiKey: key,
                model: ThreadTitleChain.MODEL,
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
  exports: [THREAD_TITLE_CHAIN, ThreadTitler],
})
export class TitlingModule {}
