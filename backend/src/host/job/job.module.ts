import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import type { Repository } from 'typeorm';
import { Job, JobRepo } from '../../_lib/database/entities/job.entity';
import { OrganizationMember } from '../../_lib/database/entities/organization-member.entity';
import { Subagent, SubagentRepo } from '../../_lib/database/entities/subagent.entity';
import { Task, TaskRepo } from '../../_lib/database/entities/task.entity';
import { ThreadGroup, ThreadGroupRepo } from '../../_lib/database/entities/thread-group.entity';
import {
  ThreadMessage,
  ThreadMessageRepo,
} from '../../_lib/database/entities/thread-message.entity';
import { Thread, ThreadRepo } from '../../_lib/database/entities/thread.entity';
import { JobController } from './job.controller';
import { buildJobRealtimeModels } from './job.realtime';
import { JobService } from './job.service';
import { MessageService } from './message.service';
import { TaskService } from './task.service';
import { ThreadService } from './thread.service';

@CreateModule({
  imports: [
    PgRealtimeModule.forFeature({
      imports: [TypeOrmModule.forFeature([OrganizationMember])],
      inject: [getRepositoryToken(OrganizationMember)],
      useFactory: (members: Repository<OrganizationMember>) => buildJobRealtimeModels(members),
    }),
  ],
  entities: [
    { entity: Job, repoClass: JobRepo },
    { entity: ThreadGroup, repoClass: ThreadGroupRepo },
    { entity: Thread, repoClass: ThreadRepo },
    { entity: ThreadMessage, repoClass: ThreadMessageRepo },
    { entity: Subagent, repoClass: SubagentRepo },
    { entity: Task, repoClass: TaskRepo },
  ],
  services: [JobService, ThreadService, MessageService, TaskService],
  controllers: [JobController],
})
export class JobModule {}
