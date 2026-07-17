import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobDependencyEntity, JobEntity } from '../persistence/entities';
import { StimulusModule } from '../stimulus/stimulus.module';
import { JobDependencyService } from './job-dependency.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([JobDependencyEntity, JobEntity], DB_CONNECTION),
    StimulusModule,
  ],
  providers: [JobDependencyService],
  exports: [JobDependencyService],
})
export class JobDependencyModule {}
