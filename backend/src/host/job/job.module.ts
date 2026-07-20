import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import type { Repository } from 'typeorm';
import { OrganizationMember } from '../org/entities/organization-member.entity';
import { Job, JobRepo } from './entities/job.entity';
import { Subagent, SubagentRepo } from './entities/subagent.entity';
import { Task, TaskRepo } from './entities/task.entity';
import { ThreadGroup, ThreadGroupRepo } from './entities/thread-group.entity';
import { ThreadMessage, ThreadMessageRepo } from './entities/thread-message.entity';
import { Thread, ThreadRepo } from './entities/thread.entity';
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
