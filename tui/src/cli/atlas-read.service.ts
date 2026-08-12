import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { withSeams } from '../domain/seam.js';
import { ATLAS_PATHS, jobContextDir } from '../domain/paths.js';
import { JobRepository } from '../store/job.repository.js';
import { MessageRepository } from '../store/message.repository.js';
import { SessionRepository } from '../store/session.repository.js';
import { ThreadRepository, type ThreadRow } from '../store/thread.repository.js';
import { readMap, readTicket } from './context-files.js';
import { formatThreadTree } from './format/thread-tree.js';
import { formatTranscript } from './format/transcript.js';
import { ECliCommand, type CliCommand } from './invocation.js';
import { found, missing, type CliResult } from './result.js';
import type { CliJobView, CliPhaseView, CliSessionView, CliThreadView } from './views.js';

/**
 * Every read an agent can perform on Atlas itself. It composes the existing repositories and the
 * job's context folder and owns no queries of its own — the store's shape stays in the store layer,
 * where the TUI reads it from too, so a CLI answer and a screen can never disagree.
 */
@Injectable()
export class AtlasReadService {
  constructor(
    private readonly jobRepository: JobRepository,
    private readonly threadRepository: ThreadRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly messageRepository: MessageRepository,
  ) {}

  async run(command: CliCommand): Promise<CliResult> {
    switch (command.name) {
      case ECliCommand.threads:
        return this.threads(command.jobId);
      case ECliCommand.transcript:
        return this.transcript({ threadId: command.threadId, full: command.full });
      case ECliCommand.map:
        return this.inIntake({ jobId: command.jobId, read: readMap });
      case ECliCommand.ticket:
        return this.inIntake({
          jobId: command.jobId,
          read: (intakeDir) => readTicket({ intakeDir, ticketNumber: command.ticketNumber }),
        });
      case ECliCommand.help:
        return found('');
    }
  }

  private async threads(jobId: string): Promise<CliResult> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) return missing(jobNotFound(jobId));

    const rows = await this.threadRepository.listForJob(jobId);
    const sessions = new Map(
      await Promise.all(
        rows.map(
          async (row) => [row.id, await this.sessionRepository.refsForThread(row.id)] as const,
        ),
      ),
    );
    const currentPhase = await this.jobRepository.currentPhase(jobId);

    const view: CliJobView = {
      id: job.id,
      title: job.title,
      branch: job.branch,
      workspacePath: job.workspacePath,
      phases: toPhaseViews({
        rows,
        sessions,
        current: { id: currentPhase.id, kind: currentPhase.kind },
      }),
    };
    return found(formatThreadTree(view));
  }

  private async transcript(args: { threadId: string; full: boolean }): Promise<CliResult> {
    const thread = await this.threadRepository.findById(args.threadId);
    if (!thread) {
      return missing(`thread ${args.threadId} not found — \`atlas threads\` lists a job's thread ids`);
    }

    const [messages, sessions] = await Promise.all([
      this.messageRepository.listForThread(thread.id),
      this.sessionRepository.refsForThread(thread.id),
    ]);

    return found(
      formatTranscript({
        header: {
          threadId: thread.id,
          role: thread.role,
          status: thread.status,
          phaseId: thread.phaseId,
          messageCount: messages.length,
          createdAt: thread.createdAt,
          closedAt: thread.closedAt,
        },
        // Seams are derived, never stored — two adjacent messages disagreeing about their session IS
        // the rotation, and it is the one discontinuity a reader must be told about.
        items: withSeams(messages, sessions),
        full: args.full,
      }),
    );
  }

  /** The job must exist before its folder is consulted, or a typo'd id reads as "no map written yet". */
  private async inIntake(args: {
    jobId: string;
    read: (intakeDir: string) => CliResult;
  }): Promise<CliResult> {
    const job = await this.jobRepository.findById(args.jobId);
    if (!job) return missing(jobNotFound(args.jobId));
    return args.read(join(jobContextDir(args.jobId), INTAKE_BUCKET));
  }
}

/** Where the map and the ticket files live — the bucket named for the phase that writes them. */
const INTAKE_BUCKET = 'intake';

/**
 * Grouped by encounter order, because `listForJob` already returns phase-ordinal ascending and the
 * row type carries no ordinal of its own. A phase with no threads yet is invisible to that query, so
 * the CURRENT phase is appended when missing: an agent that just advanced must still see the phase
 * it is standing in, empty or not.
 */
function toPhaseViews(args: {
  rows: readonly ThreadRow[];
  sessions: ReadonlyMap<string, readonly CliSessionView[]>;
  current: { id: string; kind: CliPhaseView['kind'] };
}): CliPhaseView[] {
  const phases = new Map<string, CliPhaseView>();

  for (const row of args.rows) {
    const phase = phases.get(row.phaseId) ?? {
      id: row.phaseId,
      kind: row.phaseKind,
      current: row.phaseId === args.current.id,
      threads: [],
    };
    phase.threads.push(toThreadView(row, args.sessions.get(row.id) ?? []));
    phases.set(row.phaseId, phase);
  }

  if (!phases.has(args.current.id)) {
    phases.set(args.current.id, {
      id: args.current.id,
      kind: args.current.kind,
      current: true,
      threads: [],
    });
  }
  return [...phases.values()];
}

function toThreadView(row: ThreadRow, sessions: readonly CliSessionView[]): CliThreadView {
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    sessions: sessions.map((session) => ({
      ordinal: session.ordinal,
      endReason: session.endReason,
    })),
  };
}

function jobNotFound(jobId: string): string {
  return `job ${jobId} not found in ${ATLAS_PATHS.database} — pass --job <jobId>, or open the job in the TUI to see its id`;
}
