/**
 * prompt-kit / job-kind — the JOB-TYPE dimension of prompt composition.
 *
 * A job carries a `kind` (see `domain/job.ts` `JobKind`). The kind changes how an agent should orient:
 * an onboarding job is bootstrapping a repo it has never seen; an event job was seeded by an external
 * signal and is untrusted intake; feature/bugfix are the normal build kinds. `jobKindFragment` turns a
 * kind into a short context block that gated `@Fragment` methods in `job-kind.group.ts` /
 * `driver-framing.group.ts` splice in.
 *
 * A `null`/unknown kind yields the empty string, so a prompt without a kind simply omits this block.
 */
import type { JobKind } from '../domain';

// Each block ORIENTS the agent to the kind of job — it does NOT re-summarize the workflow the body
// already owns (that only bloats the composed prompt). `onboarding` is '' because an onboarding job
// ALWAYS composes with the onboarding BODY, which already covers the mission — a job-kind block would
// duplicate it. `event`'s trust boundary lives at the per-delivery seam (`renderEventDelivery`), so this
// block only names the kind, it doesn't re-litigate the security posture.
const FRAGMENTS: Record<JobKind, string> = {
  feature: 'JOB KIND — FEATURE. This job builds ONE new capability.',
  bugfix:
    'JOB KIND — BUGFIX. This job fixes ONE defect: reproduce the failure first, make the smallest correct ' +
    'change, and prove the bug is gone by re-running the exact reproduction.',
  onboarding: '',
  event:
    'JOB KIND — EVENT. This job was seeded by an EXTERNAL notification/CI signal, not by the operator ' +
    'directly.',
  // '' — like onboarding, a review job composes with its OWN persona (the ReviewGroup: identity + scope +
  // finder angles + verify + present, gated `isReview`), which owns the framing. A job-kind block would dup it.
  review: '',
};

/** The context block for a job kind, or '' when the kind is null/unknown (or owned by the body). */
export function jobKindFragment(kind: JobKind | null | undefined): string {
  if (!kind) return '';
  return FRAGMENTS[kind] ?? '';
}
