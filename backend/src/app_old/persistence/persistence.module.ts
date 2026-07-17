import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION, OrmConnectionModule } from './database.module';
import { ENTITIES } from './entities';
import { MessageGitShaSubscriber } from './message-git-sha.subscriber';

@Module({
  imports: [OrmConnectionModule, TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
  providers: [MessageGitShaSubscriber],
  exports: [TypeOrmModule],
})
export class PersistenceModule {}
