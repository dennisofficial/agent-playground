import { PgbaseModule } from '@lib/pgbase/pgbase.module';
import { CreateModule } from '@dltech/nestjs-core';
import { OrgRealtimeResourcesService } from './org-realtime-resources.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

@CreateModule({
  imports: [PgbaseModule],
  services: [OrgService, OrgRealtimeResourcesService],
  controllers: [OrgController],
})
export class OrgModule {}
