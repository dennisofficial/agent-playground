import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import { ExposureService } from './exposure.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([JobEntity], DB_CONNECTION)],
  providers: [ExposureService],
  exports: [ExposureService],
})
export class ExposureModule {}
