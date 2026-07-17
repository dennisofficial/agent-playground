import { Global, Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service';
import { SectionStampService } from './section-stamp.service';

@Global()
@Module({
  providers: [RealtimeService, SectionStampService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
