/**
 * The board registry — mirrors `engines/index.ts`. The local SQLite board is the default; a real Jira
 * adapter swaps in via `BOARD=jira` once implemented. Callers use `getBoard()` and never import a concrete
 * adapter, so the backend is a one-line config change.
 */
import { jiraBoard } from './jira.js';
import { localBoard } from './local.js';
import type { Board } from './types.js';

export type { Board, NewTicket, Ticket, TicketFilter, TicketPlan, TicketStatus } from './types.js';

export type BoardName = 'local' | 'jira';

const BOARDS: Record<BoardName, Board> = {
  local: localBoard,
  jira: jiraBoard,
};

/** The active board — `BOARD` env override, else the local SQLite board. */
export function getBoard(): Board {
  const env = process.env.BOARD as BoardName | undefined;
  return env && env in BOARDS ? BOARDS[env] : localBoard;
}
