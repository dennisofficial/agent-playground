import { describe, expect, it, vi } from 'vitest';
import type { ChangeEvent, Row, RowDelta } from '../types';
import { applyMatch, type MatchContext } from './matcher';

/** Membership predicate for tests: a row is "in the set" iff active === true. */
const isActive = { test: (o: Row) => o.active === true };

function makeCtx(
  over: Partial<MatchContext> & { initialIds?: string[] } = {},
): { ctx: MatchContext; deltas: RowDelta[] } {
  const deltas: RowDelta[] = [];
  const ctx: MatchContext = {
    effQuery: over.effQuery ?? isActive,
    documentIds: new Set(over.initialIds ?? []),
    refetchOnUpdate: over.refetchOnUpdate ?? false,
    mapRow: over.mapRow ?? ((r) => r),
    refetch: over.refetch ?? (async () => null),
    emit: (d) => deltas.push(d),
  };
  return { ctx, deltas };
}

function ev(over: Partial<ChangeEvent> & Pick<ChangeEvent, 'op' | 'pk'>): ChangeEvent {
  return {
    schema: 'public',
    table: 'threads',
    row: null,
    oldRow: null,
    toastIncomplete: false,
    lsn: '0/10',
    ...over,
  };
}

describe('applyMatch transition table', () => {
  it('delete of a tracked row → remove + drops the pk', async () => {
    const { ctx, deltas } = makeCtx({ initialIds: ['p1'] });
    await applyMatch(ctx, ev({ op: 'delete', pk: 'p1' }));
    expect(deltas).toEqual([{ kind: 'remove', pk: 'p1' }]);
    expect(ctx.documentIds.has('p1')).toBe(false);
  });

  it('delete of an untracked row → nothing', async () => {
    const { ctx, deltas } = makeCtx();
    await applyMatch(ctx, ev({ op: 'delete', pk: 'p1' }));
    expect(deltas).toEqual([]);
  });

  it('insert that passes → add + tracks the pk', async () => {
    const { ctx, deltas } = makeCtx();
    await applyMatch(ctx, ev({ op: 'insert', pk: 'p1', row: { id: 1, active: true } }));
    expect(deltas).toEqual([{ kind: 'add', pk: 'p1', row: { id: 1, active: true } }]);
    expect(ctx.documentIds.has('p1')).toBe(true);
  });

  it('insert that fails the predicate → nothing', async () => {
    const { ctx, deltas } = makeCtx();
    await applyMatch(ctx, ev({ op: 'insert', pk: 'p1', row: { id: 1, active: false } }));
    expect(deltas).toEqual([]);
    expect(ctx.documentIds.has('p1')).toBe(false);
  });

  it('insert already reflected in the snapshot → deduped (no duplicate add)', async () => {
    const { ctx, deltas } = makeCtx({ initialIds: ['p1'] });
    await applyMatch(ctx, ev({ op: 'insert', pk: 'p1', row: { id: 1, active: true } }));
    expect(deltas).toEqual([]);
  });

  it('update of a tracked row still passing → update', async () => {
    const { ctx, deltas } = makeCtx({ initialIds: ['p1'] });
    await applyMatch(ctx, ev({ op: 'update', pk: 'p1', row: { id: 1, active: true } }));
    expect(deltas).toEqual([{ kind: 'update', pk: 'p1', row: { id: 1, active: true } }]);
    expect(ctx.documentIds.has('p1')).toBe(true);
  });

  it('update of a tracked row that now fails → remove (left the set)', async () => {
    const { ctx, deltas } = makeCtx({ initialIds: ['p1'] });
    await applyMatch(ctx, ev({ op: 'update', pk: 'p1', row: { id: 1, active: false } }));
    expect(deltas).toEqual([{ kind: 'remove', pk: 'p1' }]);
    expect(ctx.documentIds.has('p1')).toBe(false);
  });

  it('update of an untracked row that now passes → add (entered the set)', async () => {
    const { ctx, deltas } = makeCtx();
    await applyMatch(ctx, ev({ op: 'update', pk: 'p1', row: { id: 1, active: true } }));
    expect(deltas).toEqual([{ kind: 'add', pk: 'p1', row: { id: 1, active: true } }]);
    expect(ctx.documentIds.has('p1')).toBe(true);
  });

  it('update of an untracked row that still fails → nothing', async () => {
    const { ctx, deltas } = makeCtx();
    await applyMatch(ctx, ev({ op: 'update', pk: 'p1', row: { id: 1, active: false } }));
    expect(deltas).toEqual([]);
    expect(ctx.documentIds.has('p1')).toBe(false);
  });
});

describe('applyMatch TOAST refetch', () => {
  it('refetches the full row before testing when an update dropped a TOAST column', async () => {
    const refetch = vi.fn(async () => ({ id: 1, active: true, body: 'full-content' }));
    const { ctx, deltas } = makeCtx({ initialIds: ['p1'], refetchOnUpdate: true, refetch });

    await applyMatch(
      ctx,
      ev({ op: 'update', pk: 'p1', row: { id: 1, active: true, body: undefined }, toastIncomplete: true }),
    );

    expect(refetch).toHaveBeenCalledOnce();
    // The emitted row carries the refetched value, never the undefined placeholder.
    expect(deltas).toEqual([
      { kind: 'update', pk: 'p1', row: { id: 1, active: true, body: 'full-content' } },
    ]);
  });

  it('does NOT refetch when the table did not opt in, even if TOAST-incomplete', async () => {
    const refetch = vi.fn(async () => null);
    const { ctx } = makeCtx({ initialIds: ['p1'], refetchOnUpdate: false, refetch });

    await applyMatch(
      ctx,
      ev({ op: 'update', pk: 'p1', row: { id: 1, active: true, body: undefined }, toastIncomplete: true }),
    );

    expect(refetch).not.toHaveBeenCalled();
  });

  it('does NOT refetch a complete update even when the table opted in', async () => {
    const refetch = vi.fn(async () => null);
    const { ctx } = makeCtx({ initialIds: ['p1'], refetchOnUpdate: true, refetch });

    await applyMatch(
      ctx,
      ev({ op: 'update', pk: 'p1', row: { id: 1, active: true }, toastIncomplete: false }),
    );

    expect(refetch).not.toHaveBeenCalled();
  });
});
