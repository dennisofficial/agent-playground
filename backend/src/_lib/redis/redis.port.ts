/**
 * The thin Redis transport seam (Phase 5).
 *
 * Phase 5's host↔daemon protocol uses only a HANDFUL of Redis operations (stream XADD/XREAD/
 * XREADGROUP + consumer-group creation, and pub/sub PUBLISH/SUBSCRIBE). Rather than scatter raw
 * `ioredis` calls — which would make every round-trip require a live Redis to test — we funnel them
 * through this narrow port. The production binding wraps an `ioredis` client; the test binding is a
 * deterministic in-memory fake (`InMemoryRedisStream`). The daemon consumer loop, the host client,
 * and both dispatchers depend ONLY on this interface, so the full round-trips unit-test with no Redis.
 *
 * Frame shape: a Redis stream entry is a flat list of field/value pairs. We always use ONE field,
 * `data`, holding the JSON-encoded frame — so the port speaks in already-parsed objects and callers
 * never touch the field encoding.
 */

/** One entry read off a stream: its server-assigned id + the decoded JSON payload. */
export interface StreamEntry<T = unknown> {
  id: string;
  data: T;
}

/** The DI token for the Redis transport port (the production ioredis binding / the test fake). */
export const REDIS_STREAM_PORT = Symbol('REDIS_STREAM_PORT');

/**
 * The minimal Redis surface Phase 5 needs. Intentionally small — add an op here (and to BOTH the
 * ioredis binding and the in-memory fake) only when a new transport need appears.
 */
export interface RedisStreamPort {
  /** Append one frame (JSON-encoded under the `data` field) to a stream; resolves the new entry id. */
  xadd(stream: string, data: unknown): Promise<string>;

  /**
   * Create a consumer group on a stream, idempotently (MKSTREAM creates the stream if absent; a
   * pre-existing group is swallowed). Safe to call on every consumer-loop boot.
   */
  ensureGroup(stream: string, group: string): Promise<void>;

  /**
   * Blocking group read: deliver up to `count` NEW (never-delivered, id '>') entries for this
   * consumer, waiting up to `blockMs` for one to arrive. Returns [] on timeout. Caller must `ack`.
   */
  xreadGroup(args: {
    group: string;
    consumer: string;
    stream: string;
    count: number;
    blockMs: number;
  }): Promise<StreamEntry[]>;

  /** Acknowledge processed entries back to their consumer group. */
  ack(stream: string, group: string, ids: string[]): Promise<void>;

  /**
   * Blocking tail read of a single stream from AFTER `lastId` (exclusive), up to `count` entries,
   * waiting up to `blockMs`. Returns [] on timeout. `lastId` of `'0'` reads from the start; pass the
   * id of the last entry seen to RESUME after a transient disconnect (events are durable on the stream).
   */
  xread(args: {
    stream: string;
    lastId: string;
    count: number;
    blockMs: number;
  }): Promise<StreamEntry[]>;

  /** Publish a JSON-encoded message on a pub/sub channel; resolves the subscriber count reached. */
  publish(channel: string, message: unknown): Promise<number>;

  /**
   * Subscribe to a pub/sub channel; `handler` is called with each decoded message until the returned
   * unsubscribe fn is invoked. Each subscription gets its OWN connection (a subscribed ioredis
   * connection can't issue normal commands), torn down on unsubscribe.
   */
  subscribe(
    channel: string,
    handler: (message: unknown) => void,
  ): Promise<() => Promise<void>>;
}
