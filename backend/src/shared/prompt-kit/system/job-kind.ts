import type { JobKind } from '../../domain';

const FRAGMENTS: Record<JobKind, string> = {
  feature: 'JOB KIND — FEATURE. This job builds ONE new capability.',
  bugfix:
    'JOB KIND — BUGFIX. This job fixes ONE defect: reproduce the failure first, make the smallest correct ' +
    'change, and prove the bug is gone by re-running the exact reproduction.',
  onboarding: '',
  event:
    'JOB KIND — EVENT. This job was seeded by an EXTERNAL notification/CI signal, not by the operator ' +
    'directly.',
  review: '',
};

export function jobKindFragment(kind: JobKind | null | undefined): string {
  if (!kind) return '';
  return FRAGMENTS[kind] ?? '';
}
