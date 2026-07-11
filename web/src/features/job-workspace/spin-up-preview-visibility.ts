import type { PipelineState } from "@/lib/api/types";

/**
 * Whether the ship-card "Spin up preview" button should be offered.
 *
 * The affordance is confined to the ready-to-ship gate and hides the moment the operator requests it.
 * Gating on the LIVE job status (not just the durable ship-card row) is what hides it on shipped/historical
 * transcripts: the ship card is a durable `messages` row that keeps rendering after the job ships (status →
 * `done`), so the card alone is not enough — the job must actually still be parked at the gate.
 */
export function shouldShowSpinUpPreview(
  status: PipelineState["status"] | undefined,
  previewRequestedAt: string | null | undefined,
): boolean {
  return status === "awaiting_ship_review" && previewRequestedAt == null;
}
