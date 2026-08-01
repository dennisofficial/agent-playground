export enum EInboundMessageStatus {
  // Staged in the composer, not yet sent (future: composer loads these back).
  DRAFT = 'draft',
  // Sent, sitting in the queue, not yet seen by the SDK.
  PENDING = 'pending',
  // The SDK's turn incorporated it — a thread_messages bubble was written at that moment. Terminal (happy path).
  CONSUMED = 'consumed',
  // Terminal SANS consumption: drained without the model ever seeing it (e.g. the job was archived). The
  // consumption model made this the ONLY remaining use of `delivered` — the row is retired, not handed off.
  DELIVERED = 'delivered',
}

/**
 * ┌──────────┬───────────────┬────────────────────┬───────────┐
 * │   Our    │    Meaning    │  When a turn is    │ When idle │
 * │ priority │               │      running       │           │
 * ├──────────┼───────────────┼────────────────────┼───────────┤
 * │          │               │ steer the live     │           │
 * │ now      │ at the next   │ turn (forward →    │ start a   │
 * │          │ boundary      │ SDK, injects at    │ turn      │
 * │          │               │ next boundary)     │           │
 * ├──────────┼───────────────┼────────────────────┼───────────┤
 * │          │ after this    │ wait; becomes the  │ start a   │
 * │ queued   │ turn          │ next turn when     │ turn      │
 * │          │               │ this one ends      │           │
 * ├──────────┼───────────────┼────────────────────┼───────────┤
 * │          │ dormant until │ nothing — sits     │ nothing — │
 * │ later    │  something    │ PENDING            │  sits     │
 * │          │ wakes it      │                    │ PENDING   │
 * └──────────┴───────────────┴────────────────────┴───────────┘
 */
export enum EInboundPriority {
  // Steered into the running turn (SDK `now`), or starts one if none is live.
  NOW = 'now',
  // After the current active turn
  QUEUED = 'queued',
  // Dormant until the next `NOW`/`QUEUED` message.
  LATER = 'later',
}
