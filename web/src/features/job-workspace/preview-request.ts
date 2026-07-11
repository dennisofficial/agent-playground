import type { JobKind } from "@/lib/api/types";

/** The templated operator message both "Spin up preview" buttons send. The build brain's standing
 *  LIVE PREVIEW AT THE SHIP GATE guidance turns this into a demo-ready preview handed over in chat. */
export const PREVIEW_REQUEST_TEXT =
  "Please spin up a live preview of the current build so I can test it myself — " +
  "prepare it demo-ready and send me the link plus any login I need.";

/** Build-brain job kinds (mirrors the backend `isBuildBrain` predicate): feature + bugfix + event builds.
 *  Onboarding and external-PR-review jobs are excluded — their brain has no preview guidance, so a preview
 *  request would be unguided. */
function isBuildKind(kind: JobKind): boolean {
  return kind === "feat" || kind === "fix" || kind === "event";
}

/**
 * Whether the persistent "Spin up preview" affordance should be offered for a job.
 *
 * Gated on job KIND (build-brain only) AND a live sandbox/branch — NOT status — so the button is available
 * across the whole build lifecycle (d4 "always available") but stays hidden before there is anything to
 * preview. `featureBranch` is null until the sandbox/branch is cut.
 */
export function canOfferPreview(
  kind: JobKind,
  featureBranch: string | null | undefined,
): boolean {
  return isBuildKind(kind) && Boolean(featureBranch);
}
