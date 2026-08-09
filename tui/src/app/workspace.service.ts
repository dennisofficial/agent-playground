import { Injectable } from "@nestjs/common";
import { existsSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { EThreadRole } from "../generated/prisma/enums.js";
import type { Job, Project } from "../generated/prisma/client.js";
import { jobDir, sessionTapeDir } from "../domain/paths.js";
import { AccountRepository } from "../store/account.repository.js";
import { JobRepository, type JobRow } from "../store/job.repository.js";
import { ProjectRepository } from "../store/project.repository.js";
import { ThreadRepository } from "../store/thread.repository.js";
import { ContextFolderService } from "./context-folder.service.js";
import { ConversationService } from "./conversation.service.js";
import { SessionManagerService } from "./session-manager.service.js";

export type ProjectRow = Project & { jobCount: number; exists: boolean };

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly jobRepository: JobRepository,
    private readonly threadRepository: ThreadRepository,
    private readonly accountRepository: AccountRepository,
    private readonly sessionManagerService: SessionManagerService,
    private readonly contextFolderService: ContextFolderService,
    private readonly conversationService: ConversationService,
  ) {}

  async listProjects(): Promise<ProjectRow[]> {
    const projects = await this.projectRepository.list();
    return projects.map((project) => ({
      ...project,
      exists: existsSync(project.path),
    }));
  }

  async openFolder(path: string): Promise<Project> {
    const absolute = resolve(path);
    if (!existsSync(absolute)) throw new Error(`no such folder: ${absolute}`);
    return this.projectRepository.open(absolute, basename(absolute));
  }

  async listJobs(projectId: string): Promise<JobRow[]> {
    return this.jobRepository.listForProject(projectId);
  }

  async projectsWithRunningThreads(
    threadIds: readonly string[],
  ): Promise<string[]> {
    return this.jobRepository.projectIdsForThreads(threadIds);
  }

  async createJob(projectId: string, title: string): Promise<Job> {
    const job = await this.jobRepository.create({
      projectId,
      title,
      role: EThreadRole.intake,
    });
    await this.sessionManagerService.openThread(job.id, EThreadRole.intake);
    this.contextFolderService.ensure(job.id);
    const reloaded = await this.jobRepository.findById(job.id);
    return reloaded ?? job;
  }

  async deleteJob(jobId: string): Promise<void> {
    await this.conversationService.evict(
      [jobId],
      await this.threadIdsFor([jobId]),
    );
    // Read the tape keys BEFORE the cascade — afterwards there is nothing left to ask.
    const engineSessionIds =
      await this.jobRepository.engineSessionIdsFor(jobId);
    await this.jobRepository.remove(jobId);
    this.purge(jobId, engineSessionIds);
  }

  async deleteProject(projectId: string): Promise<void> {
    const jobIds = await this.jobRepository.idsForProject(projectId);
    await this.conversationService.evict(
      jobIds,
      await this.threadIdsFor(jobIds),
    );

    const tapes = new Map<string, string[]>();
    for (const jobId of jobIds) {
      tapes.set(jobId, await this.jobRepository.engineSessionIdsFor(jobId));
    }

    await this.projectRepository.remove(projectId);
    for (const [jobId, engineSessionIds] of tapes)
      this.purge(jobId, engineSessionIds);
  }

  private async threadIdsFor(jobIds: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const jobId of jobIds) {
      const threads = await this.threadRepository.listForJob(jobId);
      ids.push(...threads.map((thread) => thread.id));
    }
    return ids;
  }

  private purge(jobId: string, engineSessionIds: readonly string[]): void {
    rmSync(jobDir(jobId), { recursive: true, force: true });
    for (const id of engineSessionIds) {
      rmSync(sessionTapeDir(id), { recursive: true, force: true });
    }
  }

  async hasAccount(): Promise<boolean> {
    return (await this.accountRepository.count()) > 0;
  }

  async touchProject(id: string): Promise<void> {
    await this.projectRepository.touch(id);
  }
}
