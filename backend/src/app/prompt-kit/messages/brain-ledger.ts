/**
 * prompt-kit / messages — server-initiated TASK messages (not system prompts).
 *
 * `BRAIN_LEDGER_PROMOTION_PROMPT` is the HARNESS-turn task that drives `promote_decisions` at ship time. It is
 * delivered as the turn's `task` (`body:`), NOT as a `systemPrompt`, so it lives OUTSIDE the fragment library
 * (which assembles system prompts). Relocated from the former `bodies/brain.body.ts`.
 */
export const BRAIN_LEDGER_PROMOTION_PROMPT = [
  'It is SHIP TIME for this thread. Record the DURABLE, cross-cutting decisions from this work into the',
  '`.atlas/decisions/` ledger so future threads inherit them — this is a build step, not a conversation.',
  '',
  '1. Read `/context/generated/decision-record.md` (your locked decisions) and the existing',
  '   `/workspace/.atlas/decisions/` (and its `index.md`).',
  '2. Select ONLY the decisions that OUTLIVE this feature — the bar: a reusable primitive / shared',
  '   mechanism, a data-model / source-of-truth call, a one-way door, or a scope boundary another effort',
  '   depends on. SKIP feature shape, this-build scope, and pure implementation mechanics. Most threads',
  '   have 0–3.',
  '3. Call `promote_decisions` ONCE with the distilled durable subset (Context / Decision / Consequences /',
  '   Alternatives in your OWN words — the invariant, not a paste of the decision record). If a new entry',
  '   replaces an existing ledger file, list its slug in `supersedes`. If NOTHING qualifies, call',
  '   `promote_decisions` with an empty `decisions: []`. Do NOT call any other tool and do NOT reply with',
  '   prose — just promote.',
].join('\n');
