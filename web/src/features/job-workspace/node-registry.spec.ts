import { describe, expect, it } from "vitest";
import { contextConvoNodeForHref } from "./node-registry";

describe("contextConvoNodeForHref", () => {
  it("maps absolute /context bucket hrefs to their node id", () => {
    expect(contextConvoNodeForHref("/context/artifacts/preview.html")).toBe(
      "artifact:preview.html",
    );
    expect(contextConvoNodeForHref("/context/specs/plan.md")).toBe(
      "spec:plan.md",
    );
    expect(
      contextConvoNodeForHref("/context/generated/decision-record.md"),
    ).toBe("gen:decision-record.md");
  });

  it("maps bucket-relative hrefs (no leading /context) to their node id", () => {
    expect(contextConvoNodeForHref("specs/plan.md")).toBe("spec:plan.md");
    expect(contextConvoNodeForHref("generated/decision-record.md")).toBe(
      "gen:decision-record.md",
    );
    expect(contextConvoNodeForHref("artifacts/sub/dir/preview.html")).toBe(
      "artifact:sub/dir/preview.html",
    );
  });

  it("strips query and hash before resolving", () => {
    expect(
      contextConvoNodeForHref("/context/artifacts/preview.html?v=2#top"),
    ).toBe("artifact:preview.html");
  });

  it("returns null for non-context, external, or unknown-bucket hrefs", () => {
    expect(contextConvoNodeForHref("/etc/passwd")).toBeNull();
    expect(contextConvoNodeForHref("http://x")).toBeNull();
    expect(contextConvoNodeForHref("foo/bar")).toBeNull();
    expect(contextConvoNodeForHref("/context/other/file.md")).toBeNull();
  });

  it("returns null for a bucket with no file path", () => {
    expect(contextConvoNodeForHref("/context/artifacts/")).toBeNull();
    expect(contextConvoNodeForHref("specs")).toBeNull();
  });

  it("returns null for path traversal", () => {
    expect(contextConvoNodeForHref("artifacts/../x")).toBeNull();
    expect(contextConvoNodeForHref("/context/specs/../../etc/passwd")).toBeNull();
  });
});
