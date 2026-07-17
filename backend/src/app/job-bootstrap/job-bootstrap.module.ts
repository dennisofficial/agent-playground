import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadEntity, ThreadGroupEntity } from '../persistence/entities';
import { JobBootstrapService } from './job-bootstrap.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ThreadGroupEntity, ThreadEntity], DB_CONNECTION)],
  providers: [JobBootstrapService],
  exports: [JobBootstrapService],
})
export class JobBootstrapModule {}
