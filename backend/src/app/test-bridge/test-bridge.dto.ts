/**
 * Wire shapes for the Atlas v2 HTTP test-bridge (`POST /test/*`). Plain interfaces — the bridge is a
 * dev/test tool driven by curl / an external driver, so it keeps the contract explicit and small. No
 * class-validator (the bridge 404s in production, hard, regardless of env vars — see
 * `TestBridgeController.assertEnabled`). Zero v1 imports.
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

/**
 * `POST /test/seed-lane` body — inject a HOST SEED directly into a build lane (the only way content reaches
 * an operator-read-only builder). Drives `LANE_SEEDER.seedLane` exactly as production host-seed producers do.
 */
export interface SeedLaneRequest {
  /** The job that owns the build lane. */
  jobId: string;
  /** The build thread to seed. Omit → the job's sole/first `builder` thread is resolved automatically. */
  threadId?: string;
  /** The engine-facing seed body. */
  message: string;
  /** `now` steers a live steerable Leg; `queue`/`later` (or `now` with no live turn) fold into the next Leg. */
  priority?: 'now' | 'queue' | 'later';
}

/** `POST /test/seed-lane` response. */
export interface SeedLaneResponse {
  ok: boolean;
  /** The resolved build thread the seed landed on. */
  threadId: string;
  /** The lane coordinate (`thread:<threadId>`). */
  lane: string;
}

/** One `active_turns` row (`GET /test/turns`) — lets a driver see when a builder Leg is live + steerable. */
export interface TurnView {
  turnId: string;
  lane: string;
  kind: string;
  status: string;
  steerable: boolean;
}

/** One `threads` row (`GET /test/threads`) — lets a driver discover the build lane's threadId. */
export interface ThreadView {
  id: string;
  kind: string;
  status: string;
  ordinal: number;
}

/** One `stimuli` row (`GET /test/stimuli`) — lets a driver watch a host seed's delivery ledger. */
export interface StimulusView {
  id: string;
  lane: string;
  priority: 'now' | 'queue' | 'later' | null;
  body: string;
  deliveredAt: string | null;
  attemptedAt: string | null;
}
