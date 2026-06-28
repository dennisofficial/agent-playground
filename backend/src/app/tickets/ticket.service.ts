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
  RepoEntity,
  TicketCounterEntity,
  TicketDependencyEntity,
  TicketEntity,
  ThreadEntity,
} from '../persistence/entities';
import { ThreadTitler } from '../titling';
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

/** The outcome of promoting a ticket to a thread. `created` is false when an existing link was reused. */
export interface PromoteResult {
  threadId: string;
  /** True if a NEW thread was created; false if the ticket was already linked (idempotent reuse). */
  created: boolean;
  /** The opening intent to seed the new thread's brain with (title + body). Empty if not newly created. */
  seedText: string;
  title: string;
}

/** A board/backlog list row — the ticket plus the cheap per-card signals the board renders. */
export interface TicketListItem {
  ticket: TicketEntity;
  /** Any blocker not yet terminal (done/cancelled). */
  blocked: boolean;
  /** The number of the first active blocker (for the "blocked by #N" badge), or null. */
  blockedBy: number | null;
  /** The thread promoted from / working this ticket, or null (drives the "in thread" badge). */
  linkedThreadId: string | null;
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
  /** The thread promoted from / working this ticket (null if none) — the 1:1 link. */
  linkedThreadId: string | null;
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
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly events: TicketEventBus,
    private readonly titler: ThreadTitler,
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

  /**
   * Board/backlog listing enriched with the cheap per-card signals (`blocked`, `blockedBy`,
   * `linkedThreadId`) the UI needs — computed in a few set-based queries rather than N detail fetches.
   * The brain's `list_tickets` tool uses the plain `list` (it doesn't need these); the web board uses this.
   */
  async listEnriched(args: {
    orgId: string;
    repoId: string;
    status?: TicketStatus;
    q?: string;
  }): Promise<TicketListItem[]> {
    const rows = await this.list(args);
    if (rows.length === 0) return [];
    const { orgId, repoId } = args;
    const [edges, threads, all] = await Promise.all([
      this.deps.find({ where: { org_id: orgId, repo_id: repoId } }),
      this.threads.find({ where: { org_id: orgId, repo_id: repoId } }),
      this.tickets.find({ where: { org_id: orgId, repo_id: repoId } }),
    ]);
    const statusById = new Map(all.map((t) => [t.id, t.status]));
    const numById = new Map(all.map((t) => [t.id, t.number]));
    const linkedByTicket = new Map<string, string>();
    for (const th of threads) if (th.ticket_id) linkedByTicket.set(th.ticket_id, th.id);
    const blockersByTicket = new Map<string, string[]>();
    for (const e of edges) {
      const arr = blockersByTicket.get(e.ticket_id) ?? [];
      arr.push(e.depends_on_ticket_id);
      blockersByTicket.set(e.ticket_id, arr);
    }
    return rows.map((t) => {
      const blockerIds = blockersByTicket.get(t.id) ?? [];
      const activeBlocker = blockerIds.find((id) => {
        const s = statusById.get(id);
        return s != null && !TICKET_TERMINAL_STATUSES.has(s as TicketStatus);
      });
      return {
        ticket: t,
        blocked: activeBlocker != null,
        blockedBy: activeBlocker != null ? (numById.get(activeBlocker) ?? null) : null,
        linkedThreadId: linkedByTicket.get(t.id) ?? null,
      };
    });
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
    const [dependsOn, blocks, linkedThreadId] = await Promise.all([
      this.byIds(args.orgId, args.repoId, dependsOnIds),
      this.byIds(args.orgId, args.repoId, blocksIds),
      this.findLinkedThread(args.orgId, ticket.id),
    ]);
    const blocked = dependsOn.some((d) => !TICKET_TERMINAL_STATUSES.has(d.status as TicketStatus));
    return { ticket, dependsOn, blocks, blocked, linkedThreadId };
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

  /**
   * Promote a ticket into a working thread — the DURABLE half (link + status flip), idempotent and
   * conflict-aware. Caller does the brain-kick (HTTP via the surface inbound; the brain tool in-process)
   * so this service stays free of a surface/brain dependency.
   *
   * Ordering matters: the thread row carries `ticket_id` (the link is written FIRST, in the insert), and
   * only THEN do we flip the ticket to `in_progress` — so a retry can't leave the ticket "in progress"
   * with no linked thread. The 1:1 is enforced by the partial unique index on `threads.ticket_id`; a
   * concurrent promote that loses the race surfaces as a unique violation we catch and resolve to the
   * winning thread (so promote is safe to call repeatedly).
   */
  async promote(args: { orgId: string; repoId: string; ticketId: string }): Promise<PromoteResult> {
    const { orgId, repoId, ticketId } = args;
    const ticket = await this.requireTicket(orgId, repoId, ticketId);
    const seedText = ticket.body ? `${ticket.title}\n\n${ticket.body}` : ticket.title;

    const existing = await this.findLinkedThread(orgId, ticketId);
    if (existing) {
      return { threadId: existing, created: false, seedText: '', title: ticket.title };
    }

    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    const baseBranch = repo?.default_branch ?? null;

    // The promoted thread gets a short, scannable sidebar title via the shared titler (fail-soft). The
    // ticket's own `title` is untouched — the board keeps the user's wording; only the thread is shortened.
    const threadTitle = await this.titler.titleFor(ticket.title, orgId);

    let threadId: string;
    try {
      const row = await this.threads.save(
        this.threads.create({
          org_id: orgId,
          repo_id: repoId,
          origin: 'control',
          surface_thread_ref: null,
          title: threadTitle,
          base_branch: baseBranch,
          ticket_id: ticketId, // the link is written FIRST (in the insert)
        }),
      );
      threadId = row.id;
    } catch (err) {
      // A concurrent promote won the partial-unique index — resolve to the winning thread, don't error.
      if (isUniqueViolation(err)) {
        const won = await this.findLinkedThread(orgId, ticketId);
        if (won) return { threadId: won, created: false, seedText: '', title: ticket.title };
      }
      throw err;
    }

    // Link persisted → now advance the ticket onto the board (only from a pre-work status).
    if (ticket.status === 'backlog' || ticket.status === 'todo') {
      ticket.status = 'in_progress';
      await this.tickets.save(ticket);
    }
    this.events.publish({ type: 'ticket_event', orgId, repoId, ticketId, kind: 'updated' });
    this.logger.log(`promoted ticket #${ticket.number} (${ticketId}) → thread ${threadId}`);
    return { threadId, created: true, seedText, title: threadTitle };
  }

  /** The thread currently linked to a ticket (org-scoped), or null. */
  async findLinkedThread(orgId: string, ticketId: string): Promise<string | null> {
    const thread = await this.threads.findOne({ where: { ticket_id: ticketId, org_id: orgId } });
    return thread?.id ?? null;
  }

  /**
   * The INVERSE of `promote`: when a ticket's driving thread is deleted, hand the ticket back to the
   * board so it doesn't strand "in progress" with no driver (the board's `in_progress`/`in_review` lanes
   * are thread-driven — a deleted thread leaves nothing to advance them). Resolve the ticket via the
   * thread's `ticket_id`, so this MUST run BEFORE the thread row is deleted.
   *
   * Only reverts a thread-driven, non-terminal status (`in_progress`/`in_review`) → `todo` (committed,
   * not started — immediately re-promotable). `done`/`cancelled` are terminal and left alone; a ticket
   * already manually parked in `todo`/`backlog` is a no-op. Idempotent and best-effort by design.
   */
  async revertForDeletedThread(args: { orgId: string; threadId: string }): Promise<void> {
    const { orgId, threadId } = args;
    const thread = await this.threads.findOne({ where: { id: threadId, org_id: orgId } });
    const ticketId = thread?.ticket_id;
    if (!ticketId) return; // thread gone, or never tied to a ticket → nothing to hand back.

    const ticket = await this.tickets.findOne({ where: { id: ticketId, org_id: orgId } });
    if (!ticket) return;
    await this.revertStrandedTicket(ticket, `driving thread ${threadId} deleted`);
  }

  /**
   * Boot-time backstop for the same invariant: a ticket parked in a thread-driven lane
   * (`in_progress`/`in_review`) whose linked thread no longer exists is STRANDED — nothing can advance it
   * (those lanes move only via a thread, and the board UI won't touch them by design). Hand each back to
   * `todo`. Covers the gaps the inline `revertForDeletedThread` can't: a crash mid-delete, a thread row
   * gone by some other path, or the PR-abandoned `closeThread` path we deliberately left out. Idempotent
   * (a reverted ticket no longer matches). Org-wide (boot sweep). Returns how many were reverted.
   */
  async reconcileStrandedTickets(): Promise<number> {
    // tickets in a thread-driven lane with NO row in `threads` pointing at them (LEFT JOIN … IS NULL).
    const stranded = await this.tickets
      .createQueryBuilder('t')
      .leftJoin(ThreadEntity, 'th', 'th.ticket_id = t.id')
      .where('t.status IN (:...statuses)', { statuses: ['in_progress', 'in_review'] })
      .andWhere('th.id IS NULL')
      .getMany();

    let reverted = 0;
    for (const ticket of stranded) {
      if (await this.revertStrandedTicket(ticket, 'no linked thread at boot')) reverted++;
    }
    if (reverted) {
      this.logger.log(`reconcileStrandedTickets: reverted ${reverted} stranded ticket(s) → todo`);
    }
    return reverted;
  }

  /**
   * Flip a thread-driven ticket (`in_progress`/`in_review`) back to the board (`todo`) and announce it.
   * No-op (returns false) for terminal/pre-work statuses — the shared core of both revert paths above.
   */
  private async revertStrandedTicket(ticket: TicketEntity, reason: string): Promise<boolean> {
    if (ticket.status !== 'in_progress' && ticket.status !== 'in_review') return false;
    ticket.status = 'todo';
    await this.tickets.save(ticket);
    this.events.publish({
      type: 'ticket_event',
      orgId: ticket.org_id,
      repoId: ticket.repo_id,
      ticketId: ticket.id,
      kind: 'updated',
    });
    this.logger.log(`reverted ticket #${ticket.number} (${ticket.id}) → todo (${reason})`);
    return true;
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

/** True for a Postgres unique-violation error (SQLSTATE 23505) — e.g. the partial-unique promote race. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
