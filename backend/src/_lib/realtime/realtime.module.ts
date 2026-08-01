import { User, UserRepo } from '@lib/database/entities/user.entity';
import { CreateModule } from '@dltech/nestjs-core';
import { RealtimeAuthService } from './realtime-auth.service';
import { ScopedFindService } from './scoped-find.service';

// Entities are loaded globally from the entities folder (see DatabaseModule's `entities` glob),
// so realtime discovery sees every `@Realtime` entity without this module registering them.
@CreateModule({
  entities: [{ entity: User, repoClass: UserRepo }],
  services: [RealtimeAuthService, ScopedFindService],
})
export class AtlasRealtimeModule {}
