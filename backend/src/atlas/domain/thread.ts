/**
 * Threading + the chat log. Notifications announce in the main timeline; each job's detailed chatter
 * lives in a THREAD off the announcement. Threads are isolated for context hygiene (same reason
 * phases reset) — cross-thread coherence is SHARED MEMORY only, never transcript sharing. One
 * `messages` table is partitioned by `thread_id`. These are the in-memory shapes (kept separate from
 * the `atlas_threads` / `atlas_messages` rows).
 */

/** Why a thread exists — a human-started chat vs. a notification-seeded job thread. */
export type ThreadOrigin = 'chat' | 'event';

/** A conversation thread within a project's channel. */
export interface Thread {
  /** Stable thread id (`atlas_threads.id`). */
  id: string;
  /** The tenant (Slack team id). */
  orgId: string;
  /** The project (and thus channel) this thread lives in. */
  repoId: string;
  /** What opened the thread. */
  origin: ThreadOrigin;
  /** The surface-native thread coordinate (e.g. the Slack root message ts); null until posted. */
  surfaceThreadRef: string | null;
  /** Short human-readable label for the thread (the feature/notification title). */
  title: string | null;
  createdAt: Date;
}

/** One message in a thread's append-only log. */
export interface Message {
  /** Stable message id (`atlas_messages.id`). */
  id: string;
  /** The thread this message belongs to (the partition key). */
  threadId: string;
  /** Author display name ("Dennis", "Atlas"). */
  author: string;
  /** Author scope id ("dennis", "atlas"). */
  authorId: string;
  /** Set when Atlas (the brain) authored it. */
  authorBotId: string | null;
  /** The message body. */
  text: string;
  createdAt: Date;
}
