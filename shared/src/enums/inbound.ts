export enum EInboundMessageStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  DELIVERED = 'delivered',
}

export enum EInboundPriority {
  NOW = 'now',
  QUEUED = 'queued',
  LATER = 'later',
}
