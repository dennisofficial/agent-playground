import type { JobMessage } from '@/lib/api/job-api';

export function messagePostedMs(message: JobMessage): number {
  const ms = Date.parse(message.postedAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function messageOrderMs(message: JobMessage): number {
  const ms = Date.parse(message.orderAt ?? message.deliveredAt ?? message.postedAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function belongsInLiveWindow(message: JobMessage, startedAt: number): boolean {
  if (messagePostedMs(message) < startedAt) return false;
  return message.source !== 'atlas';
}
