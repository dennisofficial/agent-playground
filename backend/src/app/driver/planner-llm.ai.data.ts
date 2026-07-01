import type { EvalCase } from '@workspace/ai-testing';
import type { PlanTrackInput, PlannedStep } from './planner-llm';

/**
 * Dataset for the track planner (`PlannerChains.planTrack`, running on Sonnet 5). Three cases
 * exercise the invariants the PLAN_SYSTEM prompt promises:
 *
 *  1. `feature-track`  — a normal build track. Expect 1–4 steps, last = verification.
 *  2. `delete-track`   — a removal track. An early step must PROVE the target unused (find
 *                        importers/callers/references) BEFORE any step removes it.
 *  3. `respect-locked` — a track whose plan must honour a locked data_model decision and not
 *                        re-litigate it (groundedness).
 *
 * `expected` is intentionally omitted — a plan has no single reference output; the evaluators
 * grade structural invariants + groundedness, not string equality.
 */
export const DATASET: EvalCase<PlanTrackInput, PlannedStep[]>[] = [
  {
    label: 'feature-track',
    input: {
      overview:
        'Add per-tenant rate limiting to the public API so a single org cannot exhaust shared capacity.',
      decisions: [
        {
          decisionClass: 'infrastructure',
          title: 'Rate-limit store',
          ruling:
            'Use the existing Redis (ioredis) instance as the token-bucket store. No new infrastructure or datastore.',
        },
        {
          decisionClass: 'api_contract',
          title: 'Over-limit response',
          ruling:
            'Requests over the limit return HTTP 429 with a Retry-After header. No request queuing.',
        },
      ],
      brief:
        'Implement the token-bucket rate-limiter middleware backed by Redis and wire it into the public API request pipeline.',
      handoffIn: null,
    },
  },
  {
    label: 'delete-track',
    input: {
      overview:
        'Retire the legacy v1 webhook intake now that the v2 ingress path is live and carrying all traffic.',
      decisions: [
        {
          decisionClass: 'one_way_door',
          title: 'Drop v1 webhook',
          ruling:
            'The /ingress/webhook-v1 route, its handler service, and its DTOs are removed outright. No compatibility shim, no deprecation window.',
        },
      ],
      brief:
        'Remove the deprecated v1 webhook intake path (the controller route, its handler service, and the DTOs it used) from the ingress module.',
      handoffIn: null,
    },
  },
  {
    label: 'respect-locked',
    input: {
      overview:
        'Give the thread brain passive awareness of build-pipeline milestones without interrupting the operator.',
      decisions: [
        {
          decisionClass: 'data_model',
          title: 'Awareness storage',
          ruling:
            'Store awareness markers in a jsonb column on the existing threads table (threads.pipeline_awareness). Do NOT add a new table or entity.',
        },
      ],
      brief:
        'Persist pipeline-awareness markers per thread and expose a drain-and-flush read that the next operator turn consumes.',
      handoffIn:
        'The threads table and ThreadEntity already exist and the per-thread brain turn pipeline is in place. There is no awareness storage yet.',
    },
  },
];
