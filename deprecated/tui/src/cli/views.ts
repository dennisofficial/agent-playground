import type {
  EPhaseKind,
  ESessionEndReason,
  EThreadRole,
  EThreadStatus,
} from '../generated/prisma/enums.js';

/**
 * What the formatters take. Deliberately NOT the Prisma rows: the shape a reader needs is a tree
 * (job -> phases -> threads -> sessions) while the store hands back flat lists, and stating the tree
 * as its own type is what lets the formatting be tested without a database.
 */

export type CliSessionView = {
  ordinal: number;
  /** Null while the session is still open. */
  endReason: ESessionEndReason | null;
};

export type CliThreadView = {
  id: string;
  role: EThreadRole;
  status: EThreadStatus;
  messageCount: number;
  createdAt: Date;
  closedAt: Date | null;
  sessions: CliSessionView[];
};

export type CliPhaseView = {
  id: string;
  kind: EPhaseKind;
  /** The job's newest phase — the one an agent is working in right now. */
  current: boolean;
  threads: CliThreadView[];
};

export type CliJobView = {
  id: string;
  title: string;
  branch: string | null;
  workspacePath: string | null;
  phases: CliPhaseView[];
};
