import { describe, expect, it } from 'vitest';
import type { Row } from '@workspace/pg-realtime';
import { THREADS_MODEL } from './job-realtime.model';

/**
 * The realtime row is the WIRE CONTRACT the sidebar consumes: `status` carries the pure build PHASE and
 * `halt` is the separate failure/pause axis. These guard the phase+halt split — a halted build now stays
 * `running` (its phase) and carries a `halt`, and the derived `needsYou` keys off that halt.
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
    turn_active: false,
    open_question_count: 0,
    created_at: new Date('2026-07-08T00:00:00.000Z'),
    org_id: 'org-1',
    repo_id: 'repo-1',
    ...over,
  });

  it('passes a build-failure halt through while preserving the phase, and needsYou is true', () => {
    const halt = { kind: 'failed', reason: 'build broke', at: '2026-07-08T00:00:00.000Z' };
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
});

describe('THREADS_MODEL config', () => {
  it('refetches TOAST-incomplete update rows so unchanged jsonb halt is not emitted as null', () => {
    expect(THREADS_MODEL.refetchOnUpdate).toBe(true);
  });
});
