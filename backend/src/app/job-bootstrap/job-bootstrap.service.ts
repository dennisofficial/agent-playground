import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadEntity, ThreadGroupEntity } from '../persistence/entities';

const ORDINAL_GAP = 10;

@Injectable()
export class JobBootstrapService {
  constructor(
    @InjectRepository(ThreadGroupEntity, DB_CONNECTION)
    private readonly threadGroups: Repository<ThreadGroupEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
  ) {}

  async ensurePlanningThreadGroup(jobId: string, orgId: string): Promise<void> {
    const existing = await this.threadGroups.findOne({
      where: { job_id: jobId, kind: 'planning' },
      order: { ordinal: 'ASC' },
    });
    if (existing) {
      const thread = await this.threads.findOne({
        where: { thread_group_id: existing.id },
      });
      if (!thread) await this.createPlanningThread(existing.id, jobId, orgId);
      return;
    }
    const threadGroup = await this.threadGroups.save(
      this.threadGroups.create({
        job_id: jobId,
        org_id: orgId,
        ordinal: ORDINAL_GAP,
        kind: 'planning',
        title: 'Planning',
        config: {},
      }),
    );
    await this.createPlanningThread(threadGroup.id, jobId, orgId);
  }

  async planningThreadId(jobId: string): Promise<string> {
    const threadGroup = await this.threadGroups.findOne({
      where: { job_id: jobId, kind: 'planning' },
      order: { ordinal: 'ASC' },
    });
    const thread = threadGroup
      ? await this.threads.findOne({
          where: { thread_group_id: threadGroup.id },
          order: { ordinal: 'ASC' },
        })
      : null;
    if (!thread)
      throw new Error(
        `job-bootstrap: job ${jobId} has no planning thread group thread to anchor a message`,
      );
    return thread.id;
  }

  async ciThreadId(jobId: string): Promise<string | null> {
    const thread = await this.threads.findOne({
      where: { job_id: jobId, role: 'ci' },
      order: { ordinal: 'DESC' },
    });
    return thread?.id ?? null;
  }

  private async createPlanningThread(
    threadGroupId: string,
    jobId: string,
    orgId: string,
  ): Promise<void> {
    await this.threads.save(
      this.threads.create({
        thread_group_id: threadGroupId,
        job_id: jobId,
        org_id: orgId,
        role: 'planning',
        ordinal: 0,
        brief: 'Main',
        type: 'general',
        status: 'pending',
      }),
    );
  }
}
