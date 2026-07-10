import { fileNode } from "./node-registry";

export type FileLinkResolution = { url: string; onSelect: () => void };

/** Linkify an inline-code span only when the span, minus an optional `:line`/`:line-range` suffix, exactly
 * matches a tracked repo file from the manifest. The manifest is the authority; non-file code returns null. */
export function makeResolveFileLink(
  fileSet: ReadonlySet<string>,
  pathname: string,
  searchParams: URLSearchParams,
  onSelectNode: (node: string) => void,
): (raw: string) => FileLinkResolution | null {
  return (raw: string): FileLinkResolution | null => {
    const m = /^(.*?)(?::(\d+(?:-\d+)?))?$/.exec(raw);
    const path = m?.[1] ?? raw;
    const lines = m?.[2] || undefined;
    if (!fileSet.has(path)) return null;
    const node = fileNode(path, lines);
    const qs = new URLSearchParams(searchParams);
    qs.set("file", node.slice("file:".length));
    return {
      url: `${pathname}?${qs.toString()}`,
      onSelect: () => onSelectNode(node),
    };
  };
}
