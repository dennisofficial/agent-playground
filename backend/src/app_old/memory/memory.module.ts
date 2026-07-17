import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { MemoryEntity } from '../persistence/entities';
import { EMBEDDING_PROVIDER, OpenAIEmbeddingProvider } from './embedding';
import { MemoryStore } from './memory.store';

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
