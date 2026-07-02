/** Redis key namespace for one turn `T` (all under `turn:{T}:*` so a per-turn ACL can scope it). */
export const turnKeys = (turnId: string) => ({
  /** host → engine: the turn spec (a single-entry stream the engine reads once on startup). */
  spec: `turn:${turnId}:spec`,
  /** engine → host: the durable live event log (text/thinking/tool/session/heartbeat/final/error). */
  events: `turn:${turnId}:events`,
  /** engine → host: host-bridge tool_requests (consumer-group, at-least-once + pending recovery). */
  tools: `turn:${turnId}:tools`,
  /** host → engine: tool_response/tool_error replies (tailed by id). */
  replies: `turn:${turnId}:replies`,
  /** host → engine: cooperative abort (pub/sub). */
  abort: `turn:${turnId}:abort`,
  /** host → engine: mid-turn steering messages (a durable stream, read from the turn's start). */
  input: `turn:${turnId}:input`,
});

/** The consumer group the host uses to drain a turn's tools stream (one logical host across replicas). */
export const TOOLS_GROUP = 'host';
