import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { Repository } from 'typeorm';
import type { UserMessage } from '../../_shared/domain';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import {
  CHAT_SURFACE,
  type ChatSurface,
  type InboundChatMessage,
} from '../surface/chat-surface.port';
import { StimulusIntake } from './stimulus-intake.service';

@Injectable()
export class ChatStimulusBridge implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChatStimulusBridge.name);
  private sub?: Subscription;

  constructor(
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    private readonly intake: StimulusIntake,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.sub = this.surface.inbound$.subscribe((msg) => {
      void this.onInbound(msg).catch((err) =>
        this.logger.error(`chat intake failed for ${msg.id}: ${err}`),
      );
    });

    const connectable = this.surface as ChatSurface & {
      connect?: () => Promise<unknown>;
    };
    if (typeof connectable.connect === 'function') {
      try {
        await connectable.connect();
      } catch (err) {
        this.logger.warn(`surface connect failed (inbound may be inert): ${err}`);
      }
    }
  }

  onApplicationShutdown(): void {
    this.sub?.unsubscribe();
  }

  async onInbound(msg: InboundChatMessage): Promise<void> {
    const thread = await this.resolveThread(msg);
    if (!thread) {
      this.logger.debug(
        `inbound for an unknown thread/repo (org ${msg.orgId}, repo ${msg.channel}) — ignored`,
      );
      return;
    }

    if (msg.seed) {
      await this.intake.intakeLegacySeed(
        {
          orgId: thread.org_id,
          repoId: thread.repo_id,
          jobId: thread.id,
          body: msg.text,
          seedRow: msg.seedRow,
          seedQuestionId: msg.seedQuestionId,
          seedFileId: msg.seedFileId,
          seedSecretId: msg.seedSecretId,
          seedQuestionIds: msg.seedQuestionIds,
          seedFileIds: msg.seedFileIds,
          seedSecretIds: msg.seedSecretIds,
          priority: msg.priority,
          card: msg.card,
        },
        {
          author: { id: msg.authorId, displayName: msg.authorName },
          replyRoute: { surfaceId: this.surface.name, jobRef: thread.id },
        },
      );
      return;
    }

    const message: UserMessage = {
      type: 'user',
      trust: 'trusted',
      id: '',
      orgId: thread.org_id,
      repoId: thread.repo_id,
      jobId: thread.id,
      receivedAt: msg.ts.toISOString(),
      body: msg.text,
      author: { id: msg.authorId, displayName: msg.authorName },
    };

    await this.intake.intakeChat(message, {
      author: { id: msg.authorId, displayName: msg.authorName },
      replyRoute: { surfaceId: this.surface.name, jobRef: thread.id },
      card: msg.card,
      priority: msg.priority,
    });
  }

  private async resolveThread(msg: InboundChatMessage): Promise<JobEntity | null> {
    if (msg.threadTs) {
      const existing = await this.jobs.findOne({ where: { id: msg.threadTs } });
      if (existing) return existing;
    }
    if (!msg.orgId || !msg.channel) return null;
    const thread = await this.jobs.save(
      this.jobs.create({
        org_id: msg.orgId,
        repo_id: msg.channel,
        origin: 'chat',
        surface_thread_ref: null,
        title: null,
      }),
    );
    await this.jobBootstrap?.ensurePlanningThreadGroup(thread.id, msg.orgId);
    return thread;
  }
}
