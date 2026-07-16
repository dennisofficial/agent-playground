/**
 * Small shared domain types that outlived the retired `Stimulus` union (`ChatStimulus`/`EventStimulus`
 * are gone — the typed `Message` union + `TurnEnvelope` are the brain's sole turn currency now). These
 * three still describe how a system-seeded turn RENDERS (`SeedRow`) and how an event is graded
 * (`EventSeverity`), so they live here, independent of the deleted union.
 */

/** Trust label. Chat from a known surface is `trusted`; every notification body is `untrusted`. */
export type StimulusTrust = 'trusted' | 'untrusted';

/**
 * SEED RENDER COMMAND — how a system-seeded turn appears as a visible transcript row. The console mirrors
 * the agent's transcript, so EVERY seed the brain receives must be legible; this is the per-seed strategy
 * the central `persistSeedRow` executes (Command pattern — the seed site describes the row, one handler
 * performs it). Cases:
 *   - a descriptor  → a `system_notice` (or `untrusted`) pill with a short curated `label`;
 *   - `'skip'`      → the seed's content already has a durable row elsewhere (an event body, a compaction
 *                     summary), so no row is added;
 *   - absent        → a GENERIC fallback pill, so a newly-added seed can never be silently invisible.
 * The `chunkKey` is content-stable so live delivery, the boot re-delivery sweep, and re-drive collapse to
 * ONE row. In-memory only — never persisted on the seed message itself.
 */
export type SeedRow =
  | 'skip'
  | {
      /** Short, human-readable pill text — NOT the raw engine prompt/instruction. */
      label: string;
      /** Content-stable dedup key (e.g. `seed:secret:<jobId>:<name>`). */
      chunkKey: string;
      /** Row kind. Defaults to `system_notice`; `untrusted` for fenced external data. */
      kind?: 'system_notice' | 'untrusted';
      /** `<untrusted>` provenance/severity, surfaced on the untrusted pill. */
      untrustedSource?: string;
      severity?: string;
      /** For an `untrusted` row: the TRUSTED harness framing that rode with the fenced data (the
       *  autonomous-wake preamble). Rendered as a distinct trusted block, so it never reads as untrusted. */
      framing?: string;
    };

/** Coarse urgency the notification adapter maps from its gateway's payload. */
export type EventSeverity = 'info' | 'warning' | 'critical';
