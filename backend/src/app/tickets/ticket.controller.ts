import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { TicketKind, TicketPriority, TicketStatus } from '../domain/ticket';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity, TicketEntity } from '../persistence/entities';
import { WebSurface } from '../surface/web-surface';
import { TicketService, type TicketDetail } from './ticket.service';

const OPERATOR = { authorId: 'U-OPERATOR', authorName: 'Operator' };

interface CreateTicketDto {
  title: string;
  body?: string | null;
  status?: TicketStatus;
  priority?: TicketPriority | null;
  kind?: TicketKind | null;
  dependsOn?: string[];
}
interface UpdateTicketDto {
  title?: string;
  body?: string | null;
  status?: TicketStatus;
  priority?: TicketPriority | null;
  kind?: TicketKind | null;
  sortOrder?: number;
}
interface AddDependencyDto {
  dependsOnTicketId: string;
}
interface SimilarTicketsDto {
  title: string;
  body?: string | null;
  /** Exclude a ticket from its own results (edit flow). */
  excludeTicketId?: string;
}

/**
 * TICKETS — the per-repo board/backlog HTTP edge. All routes live under
 * `/web/orgs/:orgId/repos/:repoId/tickets`, gated by the global `AuthGuard` (cookie) AND
 * `OrgMembershipGuard` (membership). Mirrors the thread controller's conventions: `@CurrentOrg` for the
 * tenant, inline DTOs + manual validation, every op scoped to the caller's org+repo. The service does
 * the field-level allow-list validation (shared with the brain tools).
 */
@Controller('web')
export class TicketController {
  private readonly logger = new Logger(TicketController.name);

  constructor(
    private readonly tickets: TicketService,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    private readonly surface: WebSurface,
  ) {}

  /**
   * `GET …/repos/:repoId/tickets?status=&q=&originJobId=` — the repo's board + backlog. `originJobId`
   * narrows to tickets captured FROM one job (the job workspace's "Tickets raised in this job" panel).
   */
  @Get('orgs/:orgId/repos/:repoId/tickets')
  @UseGuards(OrgMembershipGuard)
  async list(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('originJobId') originJobId?: string,
  ): Promise<unknown[]> {
    const rows = await this.tickets.listEnriched({
      orgId: org.id,
      repoId,
      status: status as TicketStatus | undefined,
      q,
      originJobId,
    });
    return rows.map((r) => ({
      ...toTicketDto(r.ticket),
      blocked: r.blocked,
      blockedBy: r.blockedBy,
      linkedThreadId: r.linkedThreadId,
    }));
  }

  /** `POST …/repos/:repoId/tickets` — create a ticket on the repo's board. */
  @Post('orgs/:orgId/repos/:repoId/tickets')
  @UseGuards(OrgMembershipGuard)
  async create(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Body() body: CreateTicketDto,
  ): Promise<unknown> {
    if (!body?.title?.trim()) throw new BadRequestException('title is required');
    // Resolve the repo WITHIN the caller's org — a ticket must never be planted on another org's repo.
    await this.requireRepo(repoId, org.id);
    const ticket = await this.tickets.create({
      orgId: org.id,
      repoId,
      title: body.title,
      body: body.body,
      status: body.status,
      priority: body.priority,
      kind: body.kind,
      dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn : undefined,
    });
    return toTicketDto(ticket);
  }

  /**
   * `POST …/repos/:repoId/tickets/similar` — semantic near-neighbour search over the repo's board, used
   * by the create modal to surface "one of these may already cover this" BEFORE the operator files a
   * duplicate. Read-only (creates nothing). Fail-soft: no OpenAI key configured → empty list.
   */
  @Post('orgs/:orgId/repos/:repoId/tickets/similar')
  @UseGuards(OrgMembershipGuard)
  async similar(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Body() body: SimilarTicketsDto,
  ): Promise<unknown[]> {
    if (!body?.title?.trim()) throw new BadRequestException('title is required');
    await this.requireRepo(repoId, org.id);
    const { matches } = await this.tickets.findSimilar({
      orgId: org.id,
      repoId,
      title: body.title,
      body: body.body,
      excludeTicketId: body.excludeTicketId,
    });
    return matches;
  }

  /** `GET …/tickets/:ticketId` — one ticket with its advisory dependencies + derived `blocked`. */
  @Get('orgs/:orgId/repos/:repoId/tickets/:ticketId')
  @UseGuards(OrgMembershipGuard)
  async get(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<unknown> {
    const detail = await this.tickets.get({ orgId: org.id, repoId, ticketId });
    return toTicketDetailDto(detail);
  }

  /** `PATCH …/tickets/:ticketId` — edit fields / move board column. */
  @Patch('orgs/:orgId/repos/:repoId/tickets/:ticketId')
  @UseGuards(OrgMembershipGuard)
  async update(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('ticketId') ticketId: string,
    @Body() body: UpdateTicketDto,
  ): Promise<unknown> {
    const ticket = await this.tickets.update(
      { orgId: org.id, repoId, ticketId },
      {
        title: body.title,
        body: body.body,
        status: body.status,
        priority: body.priority,
        kind: body.kind,
        sortOrder: body.sortOrder,
      },
    );
    return toTicketDto(ticket);
  }

  /** `DELETE …/tickets/:ticketId` — remove a ticket (dependency edges cascade away). */
  @Delete('orgs/:orgId/repos/:repoId/tickets/:ticketId')
  @UseGuards(OrgMembershipGuard)
  async remove(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<{ ok: boolean }> {
    await this.tickets.remove({ orgId: org.id, repoId, ticketId });
    return { ok: true };
  }

  /**
   * `POST …/tickets/:ticketId/promote` — turn a ticket into a working thread (1:1). Idempotent: a second
   * call returns the already-linked thread. On a NEW thread it seeds the brain via the surface inbound
   * (same path as thread creation), so the thread starts working the ticket on its first turn.
   */
  @Post('orgs/:orgId/repos/:repoId/tickets/:ticketId/promote')
  @UseGuards(OrgMembershipGuard)
  async promote(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<{ jobId: string; created: boolean }> {
    const result = await this.tickets.promote({ orgId: org.id, repoId, ticketId });
    if (result.created && result.seedText) {
      // Seed the new thread's opening intent — the chat bridge resolves the thread by id and triages it.
      this.surface.receiveFromClient(repoId, result.seedText, {
        orgId: org.id,
        threadTs: result.jobId,
        ...OPERATOR,
      });
    }
    this.logger.log(`promoted ticket ${ticketId} → thread ${result.jobId} (created=${result.created})`);
    return { jobId: result.jobId, created: result.created };
  }

  /** `POST …/tickets/:ticketId/dependencies` — add an advisory "blocked by" edge. */
  @Post('orgs/:orgId/repos/:repoId/tickets/:ticketId/dependencies')
  @UseGuards(OrgMembershipGuard)
  async addDependency(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('ticketId') ticketId: string,
    @Body() body: AddDependencyDto,
  ): Promise<{ ok: boolean }> {
    if (!body?.dependsOnTicketId) throw new BadRequestException('dependsOnTicketId is required');
    await this.tickets.addDependency({
      orgId: org.id,
      repoId,
      ticketId,
      dependsOnTicketId: body.dependsOnTicketId,
    });
    return { ok: true };
  }

  /** `DELETE …/tickets/:ticketId/dependencies/:depId` — remove a dependency edge. */
  @Delete('orgs/:orgId/repos/:repoId/tickets/:ticketId/dependencies/:depId')
  @UseGuards(OrgMembershipGuard)
  async removeDependency(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('ticketId') ticketId: string,
    @Param('depId') depId: string,
  ): Promise<{ ok: boolean }> {
    await this.tickets.removeDependency({ orgId: org.id, repoId, ticketId, dependencyId: depId });
    return { ok: true };
  }

  /** Resolve a repo (by uuid id) scoped to the org, or 404 — so creation never crosses tenants. */
  private async requireRepo(repoId: string, orgId: string): Promise<RepoEntity> {
    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    if (!repo) throw new NotFoundException('repo not found');
    return repo;
  }
}

function toTicketDto(t: TicketEntity): Record<string, unknown> {
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    body: t.body,
    status: t.status,
    priority: t.priority,
    kind: t.kind,
    sortOrder: t.sort_order,
    originThreadId: t.origin_job_id,
    originDecisionRecordId: t.origin_decision_record_id,
    origin: t.origin,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function toTicketDetailDto(d: TicketDetail): Record<string, unknown> {
  return {
    ...toTicketDto(d.ticket),
    blocked: d.blocked,
    linkedThreadId: d.linkedThreadId,
    dependsOn: d.dependsOn.map(toTicketRef),
    blocks: d.blocks.map(toTicketRef),
  };
}

/** A compact reference to a related ticket (for dependency lists). */
function toTicketRef(t: TicketEntity): Record<string, unknown> {
  return { id: t.id, number: t.number, title: t.title, status: t.status };
}
