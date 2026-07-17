import { Logger } from '@nestjs/common';
import type { Job } from '@shared/domain';

export const JOB_DISPATCHER = Symbol('JOB_DISPATCHER');

export interface JobDispatcher {
  dispatch(thread: Job): Promise<void>;
  retry(jobId: string): Promise<void>;
  redriveThread(
    jobId: string,
    threadId: string,
    guidance?: string,
    cap?: number,
  ): Promise<{ ok: boolean; attempt?: number; reason?: string }>;
  operatorRetryStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }>;
  operatorAcceptStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }>;
  operatorShipWithoutReview(jobId: string): Promise<{ ok: boolean; reason?: string }>;
}

export class LoggingJobDispatcher implements JobDispatcher {
  private readonly logger = new Logger('JobDispatcher');

  async dispatch(thread: Job): Promise<void> {
    this.logger.log(
      `[no-op dispatch] THREAD ${thread.id} kind=${thread.kind} title="${thread.title}" ` +
        `repo=${thread.repoId} ` +
        `decisionRecord=${thread.decisionRecordId ?? '(none)'} — W4 ThreadDriver will run this`,
    );
  }

  async retry(jobId: string): Promise<void> {
    this.logger.log(`[no-op retry] THREAD ${jobId} — W4 ThreadDriver will re-drive this`);
  }

  async redriveThread(
    jobId: string,
    threadId: string,
    _guidance?: string,
    _cap?: number,
  ): Promise<{ ok: boolean; attempt?: number; reason?: string }> {
    this.logger.log(
      `[no-op redriveThread] THREAD ${jobId} thread=${threadId} — W4 ThreadDriver will re-drive this`,
    );
    return { ok: true, attempt: 0 };
  }

  async operatorRetryStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    this.logger.log(
      `[no-op operatorRetryStuckThread] THREAD ${jobId} thread=${threadId} — W4 ThreadDriver will re-drive this`,
    );
    return { ok: true };
  }

  async operatorAcceptStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    this.logger.log(
      `[no-op operatorAcceptStuckThread] THREAD ${jobId} thread=${threadId} — W4 ThreadDriver will finalize this`,
    );
    return { ok: true };
  }

  async operatorShipWithoutReview(jobId: string): Promise<{ ok: boolean; reason?: string }> {
    this.logger.log(
      `[no-op operatorShipWithoutReview] THREAD ${jobId} — W4 ThreadDriver will finalize this`,
    );
    return { ok: true };
  }
}
