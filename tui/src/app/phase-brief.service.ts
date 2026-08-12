import { Injectable } from "@nestjs/common";
import type { Job } from "../generated/prisma/client.js";
import {
  briefFor,
  phaseBriefContext,
  type PhaseBrief,
} from "../domain/phase-spec.js";
import { JobRepository } from "../store/job.repository.js";
import { ContextFolderService } from "./context-folder.service.js";

/**
 * The one place a phase's prose is resolved: read the job's phase history, build the context the
 * brief is written against, and ask `PHASE_SPECS`.
 *
 * It is a service and not a pure function only because the context needs two reads — the phase list
 * and the context folder's absolute path. Every decision inside it is in `domain/phase-spec.ts`,
 * which is what makes "does a second `direct_build` know it is a re-entry" a unit test rather than
 * something you can only see by creating a job.
 */
@Injectable()
export class PhaseBriefService {
  constructor(
    private readonly jobRepository: JobRepository,
    private readonly contextFolderService: ContextFolderService,
  ) {}

  async forPhase(args: { job: Job; phaseId: string }): Promise<PhaseBrief> {
    const phases = await this.jobRepository.listPhases(args.job.id);
    return briefFor(
      phaseBriefContext({
        phases,
        phaseId: args.phaseId,
        jobTitle: args.job.title,
        // `ensure()` rather than `root()`: the brief names paths the agent is told to write, and a
        // folder that does not exist yet turns the first `Write` into a failure it has to explain.
        contextRoot: this.contextFolderService.ensure(args.job.id),
        branch: args.job.branch,
      }),
    );
  }
}
