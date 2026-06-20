import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AtlasDatabaseModule, ATLAS_CONNECTION } from './atlas-database.module';
import { ATLAS_ENTITIES } from './entities';

/**
 * Atlas v2 persistence root: brings up the named 'atlas' connection (`AtlasDatabaseModule`) and
 * registers every `atlas_*` entity's repository against it (exported so stores in later workstations
 * can inject them via `@InjectRepository(AtlasX, ATLAS_CONNECTION)`). Stores/repositories themselves
 * land in W1+; W0 just stands the connection + repositories up.
 */
@Module({
  imports: [
    AtlasDatabaseModule,
    TypeOrmModule.forFeature(ATLAS_ENTITIES, ATLAS_CONNECTION),
  ],
  exports: [TypeOrmModule],
})
export class PersistenceModule {}
