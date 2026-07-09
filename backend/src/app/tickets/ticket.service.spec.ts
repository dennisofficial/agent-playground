/**
 * Unit tests for `TicketService.revertForDeletedThread` — the INVERSE of `promote`. When a ticket's
 * driving thread is deleted, the ticket must be handed back to the board (→ `todo`) so it doesn't strand
 * in a thread-driven lane (`in_progress`/`in_review`) with no driver. Terminal/pre-work statuses are left
 * alone. Pure unit test: all TypeORM repos + the event bus are mocked.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { TicketStatus } from '../domain/ticket';
import type { EmbeddingProvider } from '../memory/embedding';
import type { TicketEntity, JobEntity } from '../persistence/entities';
import type { TicketEventBus } from './ticket-event-bus';
import { TicketService } from './ticket.service';

const ORG = 'org-1';
const THREAD = 'thread-1';
const TICKET = 'ticket-1';

/** A no-op embedder for tests that never exercise similarity (embed is never called). */
const NULL_EMBEDDER = {
  model: 'fake',
  embed: vi.fn(),
} as unknown as EmbeddingProvider;

/** Build a service whose threads/tickets repos return the given rows; expose the save + publish spies. */
function makeService(opts: {
  ticketId?: string | null; // what the thread's ticket_id resolves to (null = thread gone / no link)
  ticket?: Partial<TicketEntity> | null; // the ticket row tickets.findOne returns (null = not found)
}) {
  const threadRow =
    opts.ticketId === undefined
      ? null
      : ({ id: THREAD, org_id: ORG, ticket_id: opts.ticketId } as JobEntity);
  const ticketRow =
    opts.ticket === null || opts.ticket === undefined
      ? null
      : ({ id: TICKET, org_id: ORG, repo_id: 'repo-1', number: 7, status: 'in_progress', ...opts.ticket } as TicketEntity);

  const save = vi.fn(async (t: TicketEntity) => t);
  const publish = vi.fn();

  const threads = { findOne: vi.fn().mockResolvedValue(threadRow) } as unknown as Repository<JobEntity>;
  const tickets = { findOne: vi.fn().mockResolvedValue(ticketRow), save } as unknown as Repository<TicketEntity>;
  const events = { publish } as unknown as TicketEventBus;

  const svc = new TicketService(
    tickets,
    {} as never, // deps repo (unused)
    threads,
    {} as never, // decisions repo (unused)
    {} as never, // repos repo (unused)
    {} as never, // dataSource (unused)
    events,
    {} as never, // JobTitler (unused)
    NULL_EMBEDDER,
  );
  return { svc, save, publish };
}

describe('TicketService.revertForDeletedThread', () => {
  it('reverts an in_progress ticket back to todo and publishes an updated event', async () => {
    const { svc, save, publish } = makeService({ ticketId: TICKET, ticket: { status: 'in_progress' } });

    await svc.revertForDeletedThread({ orgId: ORG, jobId: THREAD });

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: TICKET, status: 'todo' }));
    expect(publish).toHaveBeenCalledWith({
      type: 'ticket_event',
      orgId: ORG,
      repoId: 'repo-1',
      ticketId: TICKET,
      kind: 'updated',
    });
  });

  it('reverts an in_review ticket back to todo', async () => {
    const { svc, save } = makeService({ ticketId: TICKET, ticket: { status: 'in_review' } });

    await svc.revertForDeletedThread({ orgId: ORG, jobId: THREAD });

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: 'todo' }));
  });

  it.each<TicketStatus>(['done', 'cancelled', 'todo', 'backlog'])(
    'leaves a %s ticket untouched (not a thread-driven lane)',
    async (status) => {
      const { svc, save, publish } = makeService({ ticketId: TICKET, ticket: { status } });

      await svc.revertForDeletedThread({ orgId: ORG, jobId: THREAD });

      expect(save).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('no-ops when the thread is not linked to a ticket', async () => {
    const { svc, save, publish } = makeService({ ticketId: null });

    await svc.revertForDeletedThread({ orgId: ORG, jobId: THREAD });

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('no-ops when the linked ticket no longer exists', async () => {
    const { svc, save, publish } = makeService({ ticketId: TICKET, ticket: null });

    await svc.revertForDeletedThread({ orgId: ORG, jobId: THREAD });

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('TicketService.list — originJobId filter', () => {
  /** A QueryBuilder stand-in that records every `andWhere(sql, params)` call; `getMany` resolves []. */
  function makeListService() {
    const andWhereCalls: Array<[string, Record<string, unknown> | undefined]> = [];
    const qb: Record<string, unknown> = {};
    qb['where'] = vi.fn(() => qb);
    qb['andWhere'] = vi.fn((sql: string, params?: Record<string, unknown>) => {
      andWhereCalls.push([sql, params]);
      return qb;
    });
    for (const m of ['orderBy', 'addOrderBy']) qb[m] = vi.fn(() => qb);
    qb['getMany'] = vi.fn().mockResolvedValue([]);
    const tickets = { createQueryBuilder: vi.fn(() => qb) } as unknown as Repository<TicketEntity>;
    const svc = new TicketService(
      tickets,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      NULL_EMBEDDER,
    );
    return { svc, andWhereCalls };
  }

  it('adds an origin_job_id clause when originJobId is given', async () => {
    const { svc, andWhereCalls } = makeListService();
    await svc.list({ orgId: ORG, repoId: 'repo-1', originJobId: THREAD });
    const clause = andWhereCalls.find(([sql]) => sql.includes('origin_job_id'));
    expect(clause).toBeDefined();
    expect(clause?.[1]).toEqual({ originJobId: THREAD });
  });

  it('omits the origin_job_id clause when originJobId is absent', async () => {
    const { svc, andWhereCalls } = makeListService();
    await svc.list({ orgId: ORG, repoId: 'repo-1' });
    expect(andWhereCalls.some(([sql]) => sql.includes('origin_job_id'))).toBe(false);
  });
});

describe('TicketService.reconcileStrandedTickets', () => {
  /** Build a service whose stranded-ticket query returns `strandedRows`; expose the save + publish spies. */
  function makeReconcileService(strandedRows: Array<Partial<TicketEntity>>) {
    const save = vi.fn(async (t: TicketEntity) => t);
    const publish = vi.fn();
    // Minimal QueryBuilder stand-in — every chained method returns the builder; getMany resolves the rows.
    const qb: Record<string, unknown> = {};
    for (const m of ['leftJoin', 'where', 'andWhere']) qb[m] = vi.fn(() => qb);
    qb['getMany'] = vi.fn().mockResolvedValue(
      strandedRows.map((r, i) => ({ id: `t${i}`, org_id: ORG, repo_id: 'repo-1', number: i, status: 'in_progress', ...r })),
    );
    const tickets = { createQueryBuilder: vi.fn(() => qb), save } as unknown as Repository<TicketEntity>;
    const events = { publish } as unknown as TicketEventBus;
    const svc = new TicketService(
      tickets,
      {} as never,
      {} as never, // threads repo (unused — the join is inside the query builder)
      {} as never,
      {} as never,
      {} as never,
      events,
      {} as never,
      NULL_EMBEDDER,
    );
    return { svc, save, publish };
  }

  it('reverts every stranded ticket the query returns and counts them', async () => {
    const { svc, save, publish } = makeReconcileService([{ status: 'in_progress' }, { status: 'in_review' }]);

    const count = await svc.reconcileStrandedTickets();

    expect(count).toBe(2);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: 'todo' }));
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('reverts nothing (count 0) when no tickets are stranded', async () => {
    const { svc, save } = makeReconcileService([]);

    expect(await svc.reconcileStrandedTickets()).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('TicketService.findSimilar', () => {
  /**
   * A QueryBuilder stand-in that records every `andWhere(sql, params)` call and resolves the given rows
   * from `getRawAndEntities`. Lets us assert the dedup query's filters without a real DB.
   */
  function makeSimilarService(opts: {
    embed?: number[] | Error; // the vector the embedder returns, or an error it throws
    rows?: Array<Partial<TicketEntity>>;
    sims?: number[];
  }) {
    const andWhereCalls: Array<[string, Record<string, unknown> | undefined]> = [];
    const entities = (opts.rows ?? []).map((r, i) => ({
      id: `t${i}`,
      number: i,
      title: `t${i}`,
      status: 'backlog',
      kind: null,
      priority: null,
      ...r,
    })) as TicketEntity[];
    const raw = (opts.sims ?? entities.map(() => 0.9)).map((sim) => ({ sim }));

    const qb: Record<string, unknown> = {};
    for (const m of ['addSelect', 'where', 'orderBy', 'limit', 'setParameter']) qb[m] = vi.fn(() => qb);
    qb['andWhere'] = vi.fn((sql: string, params?: Record<string, unknown>) => {
      andWhereCalls.push([sql, params]);
      return qb;
    });
    qb['getRawAndEntities'] = vi.fn().mockResolvedValue({ entities, raw });

    const tickets = { createQueryBuilder: vi.fn(() => qb) } as unknown as Repository<TicketEntity>;
    const embed = vi.fn(async () => {
      if (opts.embed instanceof Error) throw opts.embed;
      return opts.embed ?? [0.1, 0.2, 0.3];
    });
    const embedder = { model: 'fake', embed } as unknown as EmbeddingProvider;
    const svc = new TicketService(
      tickets,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      embedder,
    );
    return { svc, andWhereCalls, embed };
  }

  it('returns matches with their similarity, most-similar-first', async () => {
    const { svc } = makeSimilarService({
      rows: [{ id: 'a', number: 1, title: 'dup' }],
      sims: [0.97],
    });
    const { queryVector, matches } = await svc.findSimilar({
      orgId: ORG,
      repoId: 'repo-1',
      title: 'dup',
    });
    expect(queryVector).toEqual([0.1, 0.2, 0.3]);
    expect(matches).toEqual([
      { id: 'a', number: 1, title: 'dup', status: 'backlog', kind: null, priority: null, sim: 0.97 },
    ]);
  });

  it('fails soft to no matches when embedding is unavailable', async () => {
    const { svc, embed } = makeSimilarService({ embed: new Error('no OpenAI key') });
    const res = await svc.findSimilar({ orgId: ORG, repoId: 'repo-1', title: 'x' });
    expect(embed).toHaveBeenCalled();
    expect(res).toEqual({ queryVector: null, matches: [] });
  });

  it('applies the minSim floor, status exclusions and self-exclusion', async () => {
    const { svc, andWhereCalls } = makeSimilarService({ rows: [] });
    await svc.findSimilar({
      orgId: ORG,
      repoId: 'repo-1',
      title: 'x',
      minSim: 0.82,
      excludeStatuses: ['done', 'cancelled'],
      excludeTicketId: 'self',
    });
    const simClause = andWhereCalls.find(([sql]) => sql.includes('>= :minSim'));
    expect(simClause?.[1]).toEqual({ minSim: 0.82 });
    const statusClause = andWhereCalls.find(([sql]) => sql.includes('status NOT IN'));
    expect(statusClause?.[1]).toEqual({ excludeStatuses: ['done', 'cancelled'] });
    const selfClause = andWhereCalls.find(([sql]) => sql.includes('t.id != :excludeTicketId'));
    expect(selfClause?.[1]).toEqual({ excludeTicketId: 'self' });
  });

  it('defaults to excluding only cancelled tickets', async () => {
    const { svc, andWhereCalls } = makeSimilarService({ rows: [] });
    await svc.findSimilar({ orgId: ORG, repoId: 'repo-1', title: 'x' });
    const statusClause = andWhereCalls.find(([sql]) => sql.includes('status NOT IN'));
    expect(statusClause?.[1]).toEqual({ excludeStatuses: ['cancelled'] });
  });
});
