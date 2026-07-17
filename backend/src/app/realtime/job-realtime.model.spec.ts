import { describe, expect, it } from 'vitest';
import type { Row } from '@workspace/pg-realtime';
import { THREADS_MODEL } from './job-realtime.model';

/**
 * The realtime row is the WIRE CONTRACT the sidebar consumes: `status` carries the pure job phase, and
 * `needsYou` is derived from server-owned human gates (operator phases, open questions, or secret requests).
 */
describe('THREADS_MODEL.mapRow', () => {
  const mapRow = THREADS_MODEL.mapRow;
  if (!mapRow) throw new Error('THREADS_MODEL.mapRow is required');
  const baseRow = (over: Partial<Row>): Row => ({
    id: 'job-1',
    title: 'a job',
    origin: 'chat',
    kind: 'feature',
    status: 'building',
    open_question_count: 0,
    created_at: new Date('2026-07-08T00:00:00.000Z'),
    org_id: 'org-1',
    repo_id: 'repo-1',
    ...over,
  });

  it('lights needsYou in operator-owned phases', () => {
    const row = mapRow(baseRow({ status: 'awaiting_approval' }));
    expect(row.status).toBe('awaiting_approval');
    expect(row.needsYou).toBe(true);
  });

  it('does not light needsYou for a healthy building job', () => {
    const row = mapRow(baseRow({ status: 'building' }));
    expect(row.status).toBe('building');
    expect(row.needsYou).toBe(false);
  });

  it('does not light needsYou for system-owned planning work without a human gate', () => {
    const row = mapRow(baseRow({ status: 'planning' }));
    expect(row.needsYou).toBe(false);
  });

  it('lights needsYou when a durable operator question is open', () => {
    const row = mapRow(baseRow({ status: 'planning', open_question_count: 1 }));
    expect(row.needsYou).toBe(true);
  });

  it('lights needsYou when an ephemeral secret request is open', () => {
    const row = mapRow(
      baseRow({ status: 'building', awaiting_secret_id: 'sec-1' }),
    );
    expect(row.needsYou).toBe(true);
  });

  it('lights needsYou for the counted secret-request gate', () => {
    const row = mapRow(
      baseRow({
        status: 'building',
        open_secret_count: 1,
      }),
    );
    expect(row.needsYou).toBe(true);
  });
});

describe('THREADS_MODEL config', () => {
  it('refetches TOAST-incomplete update rows so unchanged jsonb halt is not emitted as null', () => {
    expect(THREADS_MODEL.refetchOnUpdate).toBe(true);
  });
});
