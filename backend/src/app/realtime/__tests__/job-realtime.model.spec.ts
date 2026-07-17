import { describe, expect, it } from 'vitest';
import type { Row } from '@workspace/pg-realtime';
import { THREADS_MODEL } from '../job-realtime.model';

/**
 * The realtime row is the WIRE CONTRACT the sidebar consumes: `status` carries the pure build PHASE,
 * `activity` the orthogonal "system working" axis, and `halt` the separate failure/pause axis. These guard
 * the split — a halted build stays `running` (its phase) and carries a `halt`, `activity` suppresses the
 * dot while the system works, and the derived `needsYou` keys off all three.
 */
describe('THREADS_MODEL.mapRow', () => {
  const mapRow = THREADS_MODEL.mapRow;
  if (!mapRow) throw new Error('THREADS_MODEL.mapRow is required');
  const baseRow = (over: Partial<Row>): Row => ({
    id: 'job-1',
    title: 'a job',
    origin: 'chat',
    kind: 'feature',
    status: 'running',
    activity: 'idle',
    open_question_count: 0,
    created_at: new Date('2026-07-08T00:00:00.000Z'),
    org_id: 'org-1',
    repo_id: 'repo-1',
    ...over,
  });

  it('passes a build-failure halt through while preserving the phase, and needsYou is true', () => {
    const halt = {
      kind: 'failed',
      reason: 'build broke',
      at: '2026-07-08T00:00:00.000Z',
    };
    const row = mapRow(baseRow({ status: 'running', halt }));
    expect(row.status).toBe('running');
    expect(row.halt).toEqual(halt);
    expect(row.needsYou).toBe(true);
  });

  it('emits halt:null and needsYou:false for a healthy running job', () => {
    const row = mapRow(baseRow({ status: 'running', halt: null }));
    expect(row.status).toBe('running');
    expect(row.halt).toBeNull();
    expect(row.needsYou).toBe(false);
  });

  it('narrows the activity axis onto the row, defaulting unknown values to idle', () => {
    expect(mapRow(baseRow({ activity: 'plan_review' })).activity).toBe(
      'plan_review',
    );
    // A malformed / unrecognized WAL value must never leak — it narrows to 'idle'.
    expect(mapRow(baseRow({ activity: 'garbage' })).activity).toBe('idle');
    expect(mapRow(baseRow({ activity: undefined })).activity).toBe('idle');
  });

  it('suppresses needsYou while a plan review runs, even when status is planning and idle-phase', () => {
    // `activity='plan_review'` is the single-table signal the mapper reads so the live dot stays dark while
    // the system owns the review (the parent turn may already be finalized).
    const row = mapRow(
      baseRow({ status: 'planning', activity: 'plan_review' }),
    );
    expect(row.activity).toBe('plan_review');
    expect(row.needsYou).toBe(false);
  });

  it('lights needsYou in an operator-owned phase once the system goes idle', () => {
    const row = mapRow(baseRow({ status: 'planning', activity: 'idle' }));
    expect(row.needsYou).toBe(true);
  });

  it('a non-idle activity never masks a halt — needsYou stays true', () => {
    const halt = {
      kind: 'failed',
      reason: 'review died',
      at: '2026-07-08T00:00:00.000Z',
    };
    const row = mapRow(
      baseRow({ status: 'planning', activity: 'plan_review', halt }),
    );
    expect(row.needsYou).toBe(true);
  });

  it('lights needsYou for the awaiting-secret soft gate while idle', () => {
    const row = mapRow(
      baseRow({
        status: 'running',
        activity: 'idle',
        awaiting_secret_id: 'sec-1',
      }),
    );
    expect(row.needsYou).toBe(true);
  });

  it('surfaces sectionFirstEntered from the raw row', () => {
    const sectionFirstEntered = { running: '2026-07-08T00:00:00.000Z' };
    const row = mapRow(baseRow({ section_first_entered: sectionFirstEntered }));
    expect(row.sectionFirstEntered).toEqual(sectionFirstEntered);
  });

  it('emits sectionFirstEntered:null when absent from the raw row', () => {
    const row = mapRow(baseRow({}));
    expect(row.sectionFirstEntered).toBeNull();
  });
});

describe('THREADS_MODEL config', () => {
  it('refetches TOAST-incomplete update rows so unchanged jsonb halt is not emitted as null', () => {
    expect(THREADS_MODEL.refetchOnUpdate).toBe(true);
  });
});
