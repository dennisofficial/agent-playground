import { PgbaseModule } from '@lib/pgbase/pgbase.module';
import { CreateModule } from '@dltech/nestjs-core';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

@CreateModule({
  imports: [PgbaseModule],
  services: [OrgService],
  controllers: [OrgController],
})
export class OrgModule {}
