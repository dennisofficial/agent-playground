import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrmConnectionModule, DB_CONNECTION } from './database.module';
import { ENTITIES } from './entities';

/**
 * Atlas v2 persistence root: brings up the named 'app' connection (`OrmConnectionModule`) and
 * registers every `app` entity's repository against it (exported so stores in later workstations
 * can inject them via `@InjectRepository(Entity, DB_CONNECTION)`). Stores/repositories themselves
 * land in W1+; W0 just stands the connection + repositories up.
 */
@Module({
  imports: [
    OrmConnectionModule,
    TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
  ],
  exports: [TypeOrmModule],
})
export class PersistenceModule {}
