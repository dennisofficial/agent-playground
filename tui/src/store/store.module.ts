import { Global, Module } from '@nestjs/common';
import { AccountRepository } from './account.repository.js';
import { JobRepository } from './job.repository.js';
import { MessageRepository } from './message.repository.js';
import { MigratorService } from './migrator.service.js';
import { PrismaService } from './prisma.service.js';
import { ProjectRepository } from './project.repository.js';
import { SessionRepository } from './session.repository.js';
import { TaskRepository } from './task.repository.js';
import { ThreadRepository } from './thread.repository.js';
import { TransitionRepository } from './transition.repository.js';
import { TurnRepository } from './turn.repository.js';

/**
 * @Global because every layer above needs repositories and there is exactly one database — this is
 * infrastructure, not a feature. Re-importing it into five modules would be ceremony without
 * meaning.
 */
@Global()
@Module({
  providers: [
    MigratorService,
    PrismaService,
    AccountRepository,
    ProjectRepository,
    JobRepository,
    ThreadRepository,
    SessionRepository,
    MessageRepository,
    TurnRepository,
    TransitionRepository,
    TaskRepository,
  ],
  exports: [
    PrismaService,
    AccountRepository,
    ProjectRepository,
    JobRepository,
    ThreadRepository,
    SessionRepository,
    MessageRepository,
    TurnRepository,
    TransitionRepository,
    TaskRepository,
  ],
})
export class StoreModule {}
