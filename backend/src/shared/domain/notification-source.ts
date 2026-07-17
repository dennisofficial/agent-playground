
import type { EventKind } from './message';
import type { EventSeverity } from './seed-row';

export interface RawNotification {
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export type ParsedEvent = {
  orgId: string;
  repoId: string;
  source: string;
  dedupeKey: string;
  severity: EventSeverity;
  eventKind: EventKind;
  body: string;
  correlation?: { branch?: string | null; prNumber?: number | null };
  resumeThreadId?: string;
};

export type IngressRejectionReason =
  | 'bad-signature' // HMAC / shared-secret mismatch → 401
  | 'unverifiable' // missing signature header / no secret configured → 401
  | 'unroutable' // payload doesn't map to a known atlas_project → 404
  | 'unsupported' // a payload shape this adapter deliberately ignores (e.g. a GitHub ping) → 202
  | 'malformed'; // unparseable / missing required fields → 400

export type PrStateDelta = {
  orgId: string;
  repoId: string;
  action: 'opened' | 'closed' | 'reopened';
  prNumber: number;
  headRef: string;
  url: string;
  merged: boolean;
};

export interface CiSyncDelta {
  orgId: string;
  repoId: string;
  prNumber: number | null;
  branch: string | null;
}

export type IngressResult =
  | { outcome: 'accepted'; event: ParsedEvent }
  | { outcome: 'ignored'; reason: IngressRejectionReason; detail?: string }
  | { outcome: 'rejected'; reason: IngressRejectionReason; detail?: string }
  | { outcome: 'pr-sync'; delta: PrStateDelta }
  | { outcome: 'repo-push'; orgId: string; repoId: string }
  | {
      outcome: 'pr-rearm';
      orgId: string;
      repoId: string;
      prNumber?: number | null;
      branch?: string | null;
    };

export interface NotificationSource {
  readonly source: string;
  handle(raw: RawNotification): Promise<IngressResult>;
}
