import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { TeamTask as TeamTaskEntity } from '@workspace/shared/schemas';
import type { BoardEventsBus } from './board-events.bus';
import { BoardStore } from './board-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal BoardRow record (what the DB RETURNING * gives back). */
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    project: 'backend',
    title: 'Ship the thing',
    description: 'Do the work',
    status: 'open',
    assignee: null,
    created_by: 'sam',
    depends_on: [],
    shared_slug: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a BoardStore whose `repo.manager.query` is a vi.fn().
 * `queryResults` is an array of return values — one per successive query call.
 * The pg driver wraps UPDATE RETURNING in a [rows[], count] tuple; SELECT returns rows[].
 */
function buildStore(
  queryResults: unknown[],
  opts: { events?: BoardEventsBus } = {},
) {
  let call = 0;
  const query = vi.fn((_sql: string, _params?: unknown[]) => {
    const result = queryResults[call++] ?? [];
    return Promise.resolve(result);
  });
  const repo = { manager: { query } } as unknown as Repository<TeamTaskEntity>;
  const store = new BoardStore(repo, opts.events);
  return { store, query };
}

// ---------------------------------------------------------------------------
// BoardStore.transition() — CAS semantics
// ---------------------------------------------------------------------------

describe('BoardStore.transition() — compare-and-set semantics', () => {
  it('returns the updated task when the conditional UPDATE matches (row returned)', async () => {
    const updatedRow = makeRow({ status: 'planning', assignee: 'alex' });
    // UPDATE RETURNING → pg tuple: [rows, affectedCount]
    const { store } = buildStore([[[ updatedRow ], 1]]);

    const result = await store.transition('local', 1, 'open', {
      status: 'planning',
      assignee: 'alex',
    });

    expect(result).toBeDefined();
    expect(result!.status).toBe('planning');
    expect(result!.assignee).toBe('alex');
    expect(result!.id).toBe(1);
  });

  it('returns undefined when the conditional UPDATE returns no rows (wrong `from` status)', async () => {
    // Another actor already moved the task — the UPDATE WHERE status = $3 matches nothing.
    const { store } = buildStore([[[], 0]]);

    const result = await store.transition('local', 1, 'open', {
      status: 'planning',
    });

    expect(result).toBeUndefined();
  });

  it('a stale/concurrent verdict always loses — returns undefined', async () => {
    // Simulate: two concurrent verdicts arrive; the first wins (moved to 'approved'),
    // the second finds the wrong `from` ('awaiting_approval') and gets nothing back.
    const { store } = buildStore([[[], 0]]);

    const result = await store.transition(
      'local',
      42,
      'awaiting_approval', // stale — real status is now 'approved'
      { status: 'approved' },
    );

    expect(result).toBeUndefined();
  });

  it('fires ticket-approved event ONLY when the resulting status is approved', async () => {
    const emit = vi.fn();
    const events = { emit } as unknown as BoardEventsBus;
    const approvedRow = makeRow({ id: 7, status: 'approved' });

    const { store } = buildStore([[[approvedRow], 1]], { events });
    const result = await store.transition('local', 7, 'awaiting_approval', {
      status: 'approved',
    });

    expect(result!.status).toBe('approved');
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({
      kind: 'ticket-approved',
      team: 'local',
      taskId: 7,
    });
  });

  it('does NOT fire ticket-approved when the CAS lands on a non-approved status', async () => {
    const emit = vi.fn();
    const events = { emit } as unknown as BoardEventsBus;
    const planningRow = makeRow({ id: 3, status: 'planning' });

    const { store } = buildStore([[[planningRow], 1]], { events });
    await store.transition('local', 3, 'open', { status: 'planning' });

    expect(emit).not.toHaveBeenCalled();
  });

  it('does NOT fire ticket-approved when the CAS returns nothing (concurrent loser)', async () => {
    const emit = vi.fn();
    const events = { emit } as unknown as BoardEventsBus;

    const { store } = buildStore([[[], 0]], { events });
    await store.transition('local', 1, 'awaiting_approval', {
      status: 'approved',
    });

    expect(emit).not.toHaveBeenCalled();
  });

  it('passes the assignee patch as an additional SET clause when provided', async () => {
    const row = makeRow({ id: 2, status: 'executing', assignee: 'riley' });
    const { store, query } = buildStore([[[row], 1]]);

    await store.transition('local', 2, 'approved', {
      status: 'executing',
      assignee: 'riley',
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/assignee/);
    expect(params).toContain('riley');
  });

  it('omits the assignee SET clause when assignee patch is undefined', async () => {
    const row = makeRow({ id: 5, status: 'in_review' });
    const { store, query } = buildStore([[[row], 1]]);

    await store.transition('local', 5, 'self_review', { status: 'in_review' });

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/assignee/);
  });
});
