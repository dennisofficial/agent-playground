import type { JobKind } from "@/lib/api/types";

/** The templated operator message both "Spin up preview" buttons send. The build brain's standing
 *  LIVE PREVIEW AT THE SHIP GATE guidance turns this into a demo-ready preview handed over in chat. */
export const PREVIEW_REQUEST_TEXT =
  "Please spin up a live preview of the current build so I can test it myself — " +
  "prepare it demo-ready and send me the link plus any login I need.";

/** Build-brain job kinds (mirrors the backend `isBuildBrain` predicate): feature + bugfix + event builds.
 *  Onboarding and external-PR-review jobs are excluded — their brain has no preview guidance, so a preview
 *  request would be unguided. */
function isBuildKind(kind: JobKind | null | undefined): boolean {
  return kind === "feat" || kind === "fix" || kind === "event";
}

/**
 * Whether the persistent "Spin up preview" affordance should be offered for a job.
 *
 * Gated only on job KIND (build-brain only) — NOT status or branch — so the operator can ask anytime. If
 * there is nothing meaningful to preview yet, the build brain answers that conversationally.
 */
export function canOfferPreview(kind: JobKind | null | undefined): boolean {
  return isBuildKind(kind);
}
