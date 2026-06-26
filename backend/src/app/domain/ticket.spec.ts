import { describe, expect, it } from 'vitest';
import {
  TICKET_TERMINAL_STATUSES,
  isTicketKind,
  isTicketPriority,
  isTicketStatus,
} from './ticket';

describe('ticket allow-list validators', () => {
  it('accepts only the known statuses', () => {
    for (const s of ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']) {
      expect(isTicketStatus(s)).toBe(true);
    }
    for (const bad of ['', 'open', 'doing', 'BACKLOG', 42, null, undefined, {}]) {
      expect(isTicketStatus(bad)).toBe(false);
    }
  });

  it('accepts only the known priorities', () => {
    for (const p of ['low', 'medium', 'high', 'urgent']) expect(isTicketPriority(p)).toBe(true);
    for (const bad of ['', 'normal', 'HIGH', 1, null]) expect(isTicketPriority(bad)).toBe(false);
  });

  it('accepts only the known kinds', () => {
    for (const k of ['feature', 'bug', 'chore']) expect(isTicketKind(k)).toBe(true);
    for (const bad of ['', 'task', 'Bug', null]) expect(isTicketKind(bad)).toBe(false);
  });

  it('treats only done/cancelled as terminal (non-blocking)', () => {
    expect(TICKET_TERMINAL_STATUSES.has('done')).toBe(true);
    expect(TICKET_TERMINAL_STATUSES.has('cancelled')).toBe(true);
    expect(TICKET_TERMINAL_STATUSES.has('in_progress')).toBe(false);
    expect(TICKET_TERMINAL_STATUSES.has('backlog')).toBe(false);
  });
});
