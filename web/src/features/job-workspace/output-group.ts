/**
 * An OUTPUTS sub-group (SPECS / ARTIFACTS / GENERATED / EVIDENCE) marked `hideWhenEmpty` collapses
 * entirely — no divider, no ghost empty row — when it has no files, nothing is loading, and it has no
 * children to render. This is the "hidden when empty" behavior the EVIDENCE region relies on so historical
 * jobs (which have no `evidence/`) render no clutter, and a group only appears once its first file lands.
 */
export function isOutputGroupHidden(group: {
  hideWhenEmpty?: boolean;
  fileCount: number;
  loading?: boolean;
  hasChildren: boolean;
}): boolean {
  return (
    Boolean(group.hideWhenEmpty) &&
    group.fileCount === 0 &&
    !group.loading &&
    !group.hasChildren
  );
}
