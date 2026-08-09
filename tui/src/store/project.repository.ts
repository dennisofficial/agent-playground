import { Injectable } from '@nestjs/common';
import { basename } from 'node:path';
import type { Project } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

@Injectable()
export class ProjectRepository {
  constructor(private readonly prismaService: PrismaService) {}

  /** Most recently opened first — the list is a recency stack, not an alphabetical index. */
  async list(): Promise<(Project & { jobCount: number })[]> {
    const projects = await this.prismaService.project.findMany({
      orderBy: { lastOpenedAt: 'desc' },
      include: { _count: { select: { jobs: true } } },
    });
    return projects.map(({ _count, ...project }) => ({ ...project, jobCount: _count.jobs }));
  }

  /** Opening a folder is idempotent — the path is the identity, and re-opening just bumps recency. */
  async open(path: string, name?: string): Promise<Project> {
    return this.prismaService.project.upsert({
      where: { path },
      update: { lastOpenedAt: new Date() },
      create: { path, name: name ?? basename(path), lastOpenedAt: new Date() },
    });
  }

  /**
   * Removes the project ROW and everything hanging off it. It does not touch `path` — that is the
   * user's own repository, and Atlas forgetting about a folder must never be able to delete one.
   *
   * Jobs → groups → threads → sessions/messages all go by `ON DELETE CASCADE`, which is real here:
   * the adapter sets `PRAGMA foreign_keys = ON` on every connection it opens.
   */
  async remove(id: string): Promise<void> {
    await this.prismaService.project.delete({ where: { id } });
  }

  async touch(id: string): Promise<void> {
    await this.prismaService.project.update({
      where: { id },
      data: { lastOpenedAt: new Date() },
    });
  }
}
