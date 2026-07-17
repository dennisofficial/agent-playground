import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { MemoryEntity } from '../persistence/entities';
import { EMBEDDING_PROVIDER, OpenAIEmbeddingProvider } from './embedding';
import { MemoryStore } from './memory.store';

/**
 * The Atlas v2 MEMORY module — the pgvector semantic-memory primitives (`MemoryStore`) over the
 * `memory` table + the OpenAI embedding provider. A minimal clean-room rewrite of v1's memory
 * module: NO board/pipeline/reminders/checkpointer — just the read/write vector primitives that are
 * the only cross-thread coherence channel. The `MemoryEntity` repository is provided by the persistence
 * module on the 'app' connection. Zero v1 imports.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MemoryEntity], DB_CONNECTION)],
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver) =>
        new OpenAIEmbeddingProvider((orgId) => creds.openaiKey(orgId)),
    },
    MemoryStore,
  ],
  exports: [MemoryStore, EMBEDDING_PROVIDER],
})
export class MemoryModule {}
