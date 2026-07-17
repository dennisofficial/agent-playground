import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ConventionProfileEntity, RepoEntity } from '../persistence/entities';
import { ConventionProfileResolver } from './convention-profile.resolver';
import { ConventionProfilesController } from './convention-profiles.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ConventionProfileEntity, RepoEntity], DB_CONNECTION)],
  controllers: [ConventionProfilesController],
  providers: [ConventionProfileResolver],
  exports: [ConventionProfileResolver],
})
export class ConventionsModule {}
