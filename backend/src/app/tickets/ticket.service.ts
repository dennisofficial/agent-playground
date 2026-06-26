import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  type TicketKind,
  type TicketOrigin,
  type TicketPriority,
  type TicketStatus,
  TICKET_TERMINAL_STATUSES,
  isTicketKind,
  isTicketPriority,
  isTicketStatus,
} from '../domain/ticket';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  TicketCounterEntity,
  TicketDependencyEntity,
  TicketEntity,
  ThreadEntity,
} from '../persistence/entities';
import { TicketEventBus } from './ticket-event-bus';

const MAX_TITLE = 200;
const MAX_BODY = 20_000;

/** Create input — `orgId`/`repoId` come from the caller's resolved scope, never raw client input. */
export interface CreateTicketInput {
  orgId: string;
  repoId: string;
  title: string;
  body?: string | null;
  status?: TicketStatus;
  priority?: TicketPriority | null;
  kind?: TicketKind | null;
  /** The thread this ticket was captured from (snapshotted into `origin`). */
  originThreadId?: string | null;
  /** The decision record this ticket diverged from (snapshotted into `origin`). */
  originDecisionRecordId?: string | null;
  /** Existing ticket ids in this repo that the new ticket is blocked by (advisory edges). */
  dependsOn?: string[];
}

export interface UpdateTicketPatch {
  title?: string;
  body?: string | null;
  status?: TicketStatus;
  priority?: TicketPriority | null;
  kind?: TicketKind | null;
  sortOrder?: number;
}

/** A ticket with its advisory dependency edges resolved + the derived `blocked` flag. */
export interface TicketDetail {
  ticket: TicketEntity;
  /** The blocker tickets (what this ticket depends on). */
  dependsOn: TicketEntity[];
  /** Tickets that depend ON this one (downstream). */
  blocks: TicketEntity[];
  /** True if any `dependsOn` ticket is not yet in a terminal (done/cancelled) status. */
  blocked: boolean;
}

/**
 * TICKET SERVICE — CRUD + advisory dependencies for the per-repo board/backlog. Every method is scoped
 * to `{ orgId, repoId }` (org-only scoping would leak tickets across repos in the same org). All
 * mutations publish a `ticket_event` so the board's SSE stream stays live, including when the brain
 * mutates tickets outside the HTTP flow.
 */
@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    @InjectRepository(TicketEntity, DB_CONNECTION)
    private readonly tickets: Repository<TicketEntity>,
    @InjectRepository(TicketDependencyEntity, DB_CONNECTION)
    private readonly deps: Repository<TicketDependencyEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly decisions: Repository<DecisionRecordEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly events: TicketEventBus,
  ) {}

  /** Create a ticket: allocate its per-repo number, snapshot provenance, attach any dependency edges. */
  async create(input: CreateTicketInput): Promise<TicketEntity> {
    const { orgId, repoId } = input;
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('title is required');
    if (title.length > MAX_TITLE) throw new BadRequestException(`title exceeds ${MAX_TITLE} chars`);

    const body = normalizeBody(input.body);
    const status = input.status ?? 'backlog';
    if (!isTicketStatus(status)) throw new BadRequestException(`invalid status: ${status}`);
    if (input.priority != null && !isTicketPriority(input.priority)) {
      throw new BadRequestException(`invalid priority: ${input.priority}`);
    }
    if (input.kind != null && !isTicketKind(input.kind)) {
      throw new BadRequestException(`invalid kind: ${input.kind}`);
    }

    const dependsOn = dedupe(input.dependsOn ?? []);
    const origin = await this.snapshotOrigin(
      orgId,
      repoId,
      input.originThreadId ?? null,
      input.originDecisionRecordId ?? null,
    );

    const saved = await this.dataSource.transaction(async (m) => {
      const number = await this.allocateNumber(m, repoId);
      const ticket = await m.save(
        m.create(TicketEntity, {
          org_id: orgId,
          repo_id: repoId,
          number,
          title,
          body,
          status,
          priority: input.priority ?? null,
          kind: input.kind ?? null,
          sort_order: 0,
          origin_thread_id: input.originThreadId ?? null,
          origin_decision_record_id: input.originDecisionRecordId ?? null,
          origin,
        }),
      );
      // A brand-new ticket has no incoming edges, so dependsOn edges can't form a cycle — only validate
      // that each blocker exists in this repo.
      for (const blockerId of dependsOn) {
        await this.requireTicketIn(m, orgId, repoId, blockerId);
        await m.save(
          m.create(TicketDependencyEntity, {
            org_id: orgId,
            repo_id: repoId,
            ticket_id: ticket.id,
            depends_on_ticket_id: blockerId,
          }),
        );
      }
      return ticket;
    });

    this.logger.log(`created ticket #${saved.number} (${saved.id}) on ${orgId}/${repoId}`);
    this.events.publish({ type: 'ticket_event', orgId, repoId, ticketId: saved.id, kind: 'created' });
    return saved;
  }

  /** List a repo's tickets, optionally filtered by status or a title/body substring. */
  async list(args: {
    orgId: string;
    repoId: string;
    status?: TicketStatus;
    q?: string;
  }): Promise<TicketEntity[]> {
    if (args.status != null && !isTicketStatus(args.status)) {
      throw new BadRequestException(`invalid status: ${args.status}`);
    }
    const qb = this.tickets
      .createQueryBuilder('t')
      .where('t.org_id = :orgId AND t.repo_id = :repoId', { orgId: args.orgId, repoId: args.repoId });
    if (args.status) qb.andWhere('t.status = :status', { status: args.status });
    if (args.q?.trim()) {
      qb.andWhere('(t.title ILIKE :q OR t.body ILIKE :q)', { q: `%${args.q.trim()}%` });
    }
    return qb.orderBy('t.status', 'ASC').addOrderBy('t.sort_order', 'ASC').addOrderBy('t.number', 'ASC').getMany();
  }

  /** Resolve a ticket scoped to the org+repo (or 404) plus its dependency edges + derived `blocked`. */
  async get(args: { orgId: string; repoId: string; ticketId: string }): Promise<TicketDetail> {
    const ticket = await this.requireTicket(args.orgId, args.repoId, args.ticketId);
    const [outEdges, inEdges] = await Promise.all([
      this.deps.find({ where: { repo_id: args.repoId, ticket_id: ticket.id } }),
      this.deps.find({ where: { repo_id: args.repoId, depends_on_ticket_id: ticket.id } }),
    ]);
    const dependsOnIds = outEdges.map((e) => e.depends_on_ticket_id);
    const blocksIds = inEdges.map((e) => e.ticket_id);
    const [dependsOn, blocks] = await Promise.all([
      this.byIds(args.orgId, args.repoId, dependsOnIds),
      this.byIds(args.orgId, args.repoId, blocksIds),
    ]);
    const blocked = dependsOn.some((d) => !TICKET_TERMINAL_STATUSES.has(d.status as TicketStatus));
    return { ticket, dependsOn, blocks, blocked };
  }

  /** Patch a ticket's editable fields. Only provided keys change. */
  async update(
    args: { orgId: string; repoId: string; ticketId: string },
    patch: UpdateTicketPatch,
  ): Promise<TicketEntity> {
    const ticket = await this.requireTicket(args.orgId, args.repoId, args.ticketId);

    if (patch.title !== undefined) {
      const t = patch.title?.trim();
      if (!t) throw new BadRequestException('title cannot be empty');
      if (t.length > MAX_TITLE) throw new BadRequestException(`title exceeds ${MAX_TITLE} chars`);
      ticket.title = t;
    }
    if (patch.body !== undefined) ticket.body = normalizeBody(patch.body);
    if (patch.status !== undefined) {
      if (!isTicketStatus(patch.status)) throw new BadRequestException(`invalid status: ${patch.status}`);
      ticket.status = patch.status;
    }
    if (patch.priority !== undefined) {
      if (patch.priority != null && !isTicketPriority(patch.priority)) {
        throw new BadRequestException(`invalid priority: ${patch.priority}`);
      }
      ticket.priority = patch.priority;
    }
    if (patch.kind !== undefined) {
      if (patch.kind != null && !isTicketKind(patch.kind)) {
        throw new BadRequestException(`invalid kind: ${patch.kind}`);
      }
      ticket.kind = patch.kind;
    }
    if (patch.sortOrder !== undefined) {
      if (!Number.isFinite(patch.sortOrder)) throw new BadRequestException('sortOrder must be a number');
      ticket.sort_order = patch.sortOrder;
    }

    const saved = await this.tickets.save(ticket);
    this.events.publish({
      type: 'ticket_event',
      orgId: args.orgId,
      repoId: args.repoId,
      ticketId: saved.id,
      kind: 'updated',
    });
    return saved;
  }

  /** Delete a ticket. Dependency edges referencing it cascade away via the FK. */
  async remove(args: { orgId: string; repoId: string; ticketId: string }): Promise<void> {
    const ticket = await this.requireTicket(args.orgId, args.repoId, args.ticketId);
    await this.tickets.delete({ id: ticket.id, org_id: args.orgId, repo_id: args.repoId });
    this.events.publish({
      type: 'ticket_event',
      orgId: args.orgId,
      repoId: args.repoId,
      ticketId: ticket.id,
      kind: 'deleted',
    });
  }

  /** Add an advisory "blocked by" edge: `ticketId` depends on `dependsOnTicketId`. */
  async addDependency(args: {
    orgId: string;
    repoId: string;
    ticketId: string;
    dependsOnTicketId: string;
  }): Promise<void> {
    const { orgId, repoId, ticketId, dependsOnTicketId } = args;
    if (ticketId === dependsOnTicketId) {
      throw new BadRequestException('a ticket cannot depend on itself');
    }
    // Both endpoints must exist in this org+repo (cross-repo edges are rejected).
    await this.requireTicket(orgId, repoId, ticketId);
    await this.requireTicket(orgId, repoId, dependsOnTicketId);

    if (await this.wouldCycle(repoId, ticketId, dependsOnTicketId)) {
      throw new BadRequestException('that dependency would create a cycle');
    }

    // Idempotent: the unique (ticket_id, depends_on_ticket_id) makes a repeat insert a conflict.
    await this.deps
      .createQueryBuilder()
      .insert()
      .values({ org_id: orgId, repo_id: repoId, ticket_id: ticketId, depends_on_ticket_id: dependsOnTicketId })
      .orIgnore()
      .execute();

    this.events.publish({ type: 'ticket_event', orgId, repoId, ticketId, kind: 'updated' });
  }

  /** Remove a dependency edge by its id (scoped to the ticket + repo). */
  async removeDependency(args: {
    orgId: string;
    repoId: string;
    ticketId: string;
    dependencyId: string;
  }): Promise<void> {
    const { orgId, repoId, ticketId, dependencyId } = args;
    await this.requireTicket(orgId, repoId, ticketId);
    const result = await this.deps.delete({
      id: dependencyId,
      org_id: orgId,
      repo_id: repoId,
      ticket_id: ticketId,
    });
    if (!result.affected) throw new NotFoundException('dependency not found');
    this.events.publish({ type: 'ticket_event', orgId, repoId, ticketId, kind: 'updated' });
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────

  /** Resolve a ticket scoped to org+repo or 404 — the guard for every ticket-keyed op. */
  async requireTicket(orgId: string, repoId: string, ticketId: string): Promise<TicketEntity> {
    const ticket = await this.tickets.findOne({
      where: { id: ticketId, org_id: orgId, repo_id: repoId },
    });
    if (!ticket) throw new NotFoundException('ticket not found');
    return ticket;
  }

  private async requireTicketIn(
    m: EntityManager,
    orgId: string,
    repoId: string,
    ticketId: string,
  ): Promise<void> {
    const found = await m.findOne(TicketEntity, { where: { id: ticketId, org_id: orgId, repo_id: repoId } });
    if (!found) throw new BadRequestException(`dependency ticket not found in this repo: ${ticketId}`);
  }

  private async byIds(orgId: string, repoId: string, ids: string[]): Promise<TicketEntity[]> {
    if (ids.length === 0) return [];
    return this.tickets
      .createQueryBuilder('t')
      .where('t.org_id = :orgId AND t.repo_id = :repoId', { orgId, repoId })
      .andWhereInIds(ids)
      .getMany();
  }

  /**
   * Allocate the next per-repo ticket number atomically. A `SELECT max()+1` would race (aggregate reads
   * aren't row-locked); the `ON CONFLICT … RETURNING` upsert is a single atomic advance.
   */
  private async allocateNumber(m: EntityManager, repoId: string): Promise<number> {
    const rows: Array<{ next: number }> = await m.query(
      `INSERT INTO ticket_counters (repo_id, next) VALUES ($1, 1)
       ON CONFLICT (repo_id) DO UPDATE SET next = ticket_counters.next + 1
       RETURNING next`,
      [repoId],
    );
    return Number(rows[0].next);
  }

  /**
   * Would adding "ticketId depends on dependsOnTicketId" create a cycle? It does iff dependsOnTicketId
   * already (transitively) depends on ticketId — i.e. ticketId is reachable from dependsOnTicketId by
   * following depends-on edges. Repo-scoped recursive walk.
   */
  private async wouldCycle(
    repoId: string,
    ticketId: string,
    dependsOnTicketId: string,
  ): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      `WITH RECURSIVE reach(id) AS (
         SELECT depends_on_ticket_id FROM ticket_dependencies
           WHERE repo_id = $1 AND ticket_id = $2
         UNION
         SELECT d.depends_on_ticket_id FROM ticket_dependencies d
           JOIN reach r ON d.ticket_id = r.id
           WHERE d.repo_id = $1
       )
       SELECT 1 FROM reach WHERE id = $3 LIMIT 1`,
      [repoId, dependsOnTicketId, ticketId],
    );
    return rows.length > 0;
  }

  /** Build the immutable provenance snapshot from the (optional) originating thread + decision record. */
  private async snapshotOrigin(
    orgId: string,
    repoId: string,
    threadId: string | null,
    decisionRecordId: string | null,
  ): Promise<TicketOrigin | null> {
    const origin: TicketOrigin = {};
    if (threadId) {
      const thread = await this.threads.findOne({ where: { id: threadId, org_id: orgId } });
      if (thread?.title) origin.threadTitle = thread.title;
    }
    if (decisionRecordId) {
      const dr = await this.decisions.findOne({
        where: { id: decisionRecordId, org_id: orgId, repo_id: repoId },
      });
      if (dr?.overview) origin.decisionSummary = firstLine(dr.overview);
    }
    return Object.keys(origin).length > 0 ? origin : null;
  }
}

function normalizeBody(body: string | null | undefined): string | null {
  if (body == null) return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_BODY) throw new BadRequestException(`body exceeds ${MAX_BODY} chars`);
  return trimmed;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length > 240 ? `${line.slice(0, 237)}…` : line;
}
