export enum EInboundMessageStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
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
  // At the next boundary
  NOW = 'now',
  // After the current active turn
  QUEUED = 'queued',
  // Dormant until the next `NOW`/`QUEUED` message.
  LATER = 'later',
}
