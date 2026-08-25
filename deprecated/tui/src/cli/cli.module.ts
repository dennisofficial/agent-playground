import { Module } from '@nestjs/common';
import { StoreModule } from '../store/store.module.js';
import { AtlasReadService } from './atlas-read.service.js';

/**
 * The read CLI's own root module — deliberately NOT `AppModule`. A read needs the store and nothing
 * else: no engine, no credentials, no renderer. Booting the smaller graph keeps `atlas threads` a
 * cheap thing for an agent to run in the middle of a turn, and it means a broken engine or an
 * expired token cannot stop an agent from reading its own history.
 */
@Module({
  imports: [StoreModule],
  providers: [AtlasReadService],
  exports: [AtlasReadService],
})
export class CliModule {}
