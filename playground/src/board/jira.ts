import type { Board } from './types.js';

/**
 * Placeholder for the real Jira adapter — anchors the registry so the swap point is visible. Every method
 * throws until implemented; selected only when `BOARD=jira`. When built, this maps the same `Board` surface
 * onto Jira issues + the per-discipline plan attachments (and Jira's own transitions for approval).
 */
const notImplemented = (): never => {
  throw new Error('The Jira board adapter is not implemented yet — use BOARD=local (the default).');
};

export const jiraBoard: Board = {
  name: 'jira',
  createTicket: notImplemented,
  getTicket: notImplemented,
  listTickets: notImplemented,
  setStatus: notImplemented,
  updateMeta: notImplemented,
  assign: notImplemented,
  moveTicket: notImplemented,
  addComment: notImplemented,
  listComments: notImplemented,
  attachPlan: notImplemented,
  getPlan: notImplemented,
  listPlans: notImplemented,
  approve: notImplemented,
};
