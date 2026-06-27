import { describe, expect, it } from 'vitest';
import { buildPk, pkColumns, toChangeEvent } from './normalizer';

// Minimal relation stand-ins — the normalizer only reads schema/name/keyColumns.
const relation = (over: Record<string, unknown> = {}) =>
  ({ schema: 'public', name: 'threads', keyColumns: ['id'], ...over }) as never;

describe('pkColumns', () => {
  it('prefers an explicit string override', () => {
    expect(pkColumns(relation(), 'uuid')).toEqual(['uuid']);
  });

  it('prefers an explicit array override', () => {
    expect(pkColumns(relation(), ['org_id', 'slug'])).toEqual(['org_id', 'slug']);
  });

  it('falls back to the relation replica-identity key columns', () => {
    expect(pkColumns(relation({ keyColumns: ['id'] }))).toEqual(['id']);
  });

  it('returns [] when the relation has no key columns (REPLICA IDENTITY NOTHING)', () => {
    expect(pkColumns(relation({ keyColumns: undefined }))).toEqual([]);
  });
});

describe('buildPk', () => {
  it('is a stable, order-preserving JSON array', () => {
    expect(buildPk(['org_id', 'slug'], { slug: 'b', org_id: 'a' })).toBe('["a","b"]');
  });

  it('maps a missing column to null', () => {
    expect(buildPk(['id'], { other: 1 })).toBe('[null]');
  });

  it('is empty string for a null/undefined source', () => {
    expect(buildPk(['id'], null)).toBe('');
    expect(buildPk(['id'], undefined)).toBe('');
  });
});

describe('toChangeEvent', () => {
  it('normalizes an insert, stamping commitEndLsn and full row', () => {
    const ev = toChangeEvent(
      { tag: 'insert', relation: relation(), new: { id: 7, title: 'hi' } } as never,
      '0/30',
    );
    expect(ev).toMatchObject({
      op: 'insert',
      schema: 'public',
      table: 'threads',
      pk: JSON.stringify([7]),
      row: { id: 7, title: 'hi' },
      oldRow: null,
      toastIncomplete: false,
      lsn: '0/30',
    });
  });

  it('normalizes an update and flags a dropped TOAST column', () => {
    const ev = toChangeEvent(
      {
        tag: 'update',
        relation: relation(),
        new: { id: 7, title: 'hi', body: undefined },
        old: { id: 7 },
      } as never,
      '0/40',
    );
    expect(ev.op).toBe('update');
    expect(ev.pk).toBe(JSON.stringify([7]));
    expect(ev.oldRow).toEqual({ id: 7 });
    expect(ev.toastIncomplete).toBe(true);
  });

  it('takes the PK from the new image on update', () => {
    const ev = toChangeEvent(
      { tag: 'update', relation: relation(), new: { id: 9 }, old: { id: 8 } } as never,
      '0/41',
    );
    expect(ev.pk).toBe(JSON.stringify([9]));
  });

  it('normalizes a delete using the WAL key, with no new row', () => {
    const ev = toChangeEvent(
      { tag: 'delete', relation: relation(), key: { id: 3 }, old: null } as never,
      '0/50',
    );
    expect(ev).toMatchObject({
      op: 'delete',
      row: null,
      pk: JSON.stringify([3]),
      toastIncomplete: false,
      lsn: '0/50',
    });
  });

  it('honors a composite PK override', () => {
    const ev = toChangeEvent(
      {
        tag: 'insert',
        relation: relation({ name: 'repos' }),
        new: { org_id: 'a', slug: 'b', name: 'r' },
      } as never,
      '0/60',
      ['org_id', 'slug'],
    );
    expect(ev.pk).toBe(JSON.stringify(['a', 'b']));
  });
});
