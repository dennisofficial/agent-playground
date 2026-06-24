/**
 * Wire shapes for the Atlas v2 HTTP test-bridge (`POST /test/*`). Plain interfaces — the bridge is a
 * dev/test tool driven by curl / an external driver, so it keeps the contract explicit and small. No
 * class-validator (the bridge is never exposed in prod; it 404s unless `TEST_BRIDGE=on`). Zero
 * v1 imports.
 */

/** `POST /test/seed` body — register a team/project/channel so a conversation routes to a real repo. */
export interface SeedRequest {
  /** The tenant (Slack team id) everything is keyed to. */
  orgId: string;
  /** The project slug. */
  repoId: string;
  /** The HTTPS GitHub URL the per-feature worktree sandbox clones. */
  repoUrl: string;
  /** The PR base branch (default 'main'). */
  baseBranch?: string;
  /** The surface-native channel coordinate `sendFromHuman` posts into (`atlas_channels.surface_channel_ref`). */
  channel: string;
}

/** `POST /test/seed` response. */
export interface SeedResponse {
  /** The upserted `atlas_channels.id`. */
  channelId: string;
  orgId: string;
  repoId: string;
}

/** `POST /test/say` body — inject a human message and wait for Atlas's reply. */
export interface SayRequest {
  /** The channel (`surface_channel_ref`) — resolved to its team/project to route the message. */
  channel: string;
  text: string;
  /** Continue this thread (the root ts a prior `/test/say` returned). Omit to open a new conversation. */
  threadTs?: string;
}

/** A single Atlas reply captured during the `/test/say` wait window. */
export interface SayReply {
  text: string;
  ts: string;
}

/** An approval card Atlas posted during the wait window, with the ids needed to resolve it. */
export interface SayApprovalCard {
  jobId: string;
  decisionRecordId?: string;
  title: string;
}

/** `POST /test/say` response. */
export interface SayResponse {
  /** The thread root ts — the caller threads its follow-ups onto this. */
  threadTs: string;
  /** Atlas's posts into the thread during the wait window, in order. */
  replies: SayReply[];
  /** Present when Atlas posted an approval card. */
  approvalCard?: SayApprovalCard;
}

/** `POST /test/approve` body — rule on a pending plan approval. */
export interface ApproveRequest {
  jobId: string;
  /** Default 'approve'. */
  verdict?: 'approve' | 'request_changes' | 'deny';
}

/** `GET /test/job` response — the `jobs` row. */
export interface JobView {
  id: string;
  status: string;
  title: string;
  prUrl: string | null;
  kind: string;
}

/** One line of a thread transcript (`GET /test/thread`). */
export interface ThreadLine {
  author: string;
  isAtlas: boolean;
  text: string;
}
