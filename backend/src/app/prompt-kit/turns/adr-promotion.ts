/**
 * prompt-kit / turns / adr-promotion — the SHIP-TIME ADR promotion turn. The host delivers
 * `ADR_PROMOTION_TURN.task` as a harness-turn body
 * (no system prompt) to drive `promote_adr`: distill the DURABLE, cross-cutting decisions from this thread
 * into `.atlas/adr/` so future threads inherit them. Task-only — see `HarnessTurn`.
 */
import type { HarnessTurn } from './turn';

export const ADR_PROMOTION_TURN: HarnessTurn = {
  task: [
    'It is SHIP TIME for this thread. Record the DURABLE, cross-cutting decisions from this work into the',
    '`.atlas/adr/` ADR store so future threads inherit them — this is a build step, not a conversation.',
    '',
    '1. Read `/context/generated/decision-record.md` (your locked decisions) and the existing',
    '   `/workspace/.atlas/adr/*.md` files directly.',
    '2. Select ONLY the decisions that OUTLIVE this feature — the bar: a reusable primitive / shared',
    '   mechanism, a data-model / source-of-truth call, a one-way door, or a scope boundary another effort',
    '   depends on. SKIP feature shape, this-build scope, and pure implementation mechanics. Most threads',
    '   have 0–3.',
    '3. Call `promote_adr` ONCE with the distilled durable subset (Context / Decision / Consequences /',
    '   Alternatives in your OWN words — the invariant, not a paste of the decision record). If a new entry',
    '   replaces an existing ADR file, list its slug in `supersedes`. If NOTHING qualifies, call',
    '   `promote_adr` with an empty `decisions: []`. Do NOT call any other tool and do NOT reply with',
    '   prose — just promote.',
  ].join('\n'),
};
