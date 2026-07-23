import { User, UserRepo } from '@lib/database/entities/user.entity';
import { CreateModule } from '@workspace/nestjs-core';
import { RealtimeAuthService } from './realtime-auth.service';
import { ScopedFindService } from './scoped-find.service';

@CreateModule({
  entities: [{ entity: User, repoClass: UserRepo }],
  services: [RealtimeAuthService, ScopedFindService],
})
export class AtlasRealtimeModule {}
