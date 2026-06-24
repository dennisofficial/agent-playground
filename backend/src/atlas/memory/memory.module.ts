import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CredentialResolver } from '../onboarding';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasMemory } from '../persistence/entities';
import { AtlasMemoryStore } from './atlas-memory.store';
import {
  ATLAS_EMBEDDING_PROVIDER,
  OpenAIEmbeddingProvider,
} from './embedding';

/**
 * The Atlas v2 MEMORY module — the pgvector semantic-memory primitives (`AtlasMemoryStore`) over the
 * `atlas_memory` table + the OpenAI embedding provider. A minimal clean-room rewrite of v1's memory
 * module: NO board/pipeline/reminders/checkpointer — just the read/write vector primitives that are
 * the only cross-thread coherence channel. The `AtlasMemory` repository is provided by the persistence
 * module on the 'atlas' connection. Zero v1 imports.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AtlasMemory], ATLAS_CONNECTION)],
  providers: [
    {
      provide: ATLAS_EMBEDDING_PROVIDER,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver) =>
        new OpenAIEmbeddingProvider((orgId) => creds.openaiKey(orgId)),
    },
    AtlasMemoryStore,
  ],
  exports: [AtlasMemoryStore, ATLAS_EMBEDDING_PROVIDER],
})
export class MemoryModule {}
