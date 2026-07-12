import { describe, expect, it } from "vitest";
import { deriveLineAnchor } from "./diff-pane";
import { formatReviewComments, type ReviewComment } from "./review-comments";

describe("deriveLineAnchor", () => {
  it("returns null for an empty selection", () => {
    expect(deriveLineAnchor([])).toBeNull();
  });

  it("anchors a mixed add/del/context range to the new side and joins the code", () => {
    const anchor = deriveLineAnchor([
      { type: "context", oldNo: 10, newNo: 10, code: "const a = 1;" },
      { type: "del", oldNo: 11, code: "const old = 2;" },
      { type: "add", newNo: 11, code: "const b = 2;" },
    ]);
    expect(anchor).toEqual({
      side: "new",
      start: 10,
      end: 11,
      code: "const a = 1;\nconst old = 2;\nconst b = 2;",
    });
  });

  it("anchors a pure-deletion range to the old side using old line numbers", () => {
    const anchor = deriveLineAnchor([
      { type: "del", oldNo: 20, code: "gone();" },
      { type: "del", oldNo: 21, code: "also_gone();" },
    ]);
    expect(anchor).toEqual({
      side: "old",
      start: 20,
      end: 21,
      code: "gone();\nalso_gone();",
    });
  });
});

describe("formatReviewComments (line-anchored)", () => {
  const lineComment: ReviewComment = {
    id: "1",
    file: { node: "diff", label: "diff-pane.tsx" },
    quote: "const b = 2;",
    note: "rename b",
    lines: {
      path: "web/src/features/job-workspace/diff-pane.tsx",
      side: "new",
      start: 11,
      end: 11,
    },
  };

  it("renders a line-anchored comment as `path:start-end` (side) + fenced code, not a blockquote", () => {
    const text = formatReviewComments([lineComment]);
    expect(text).toContain(
      "`web/src/features/job-workspace/diff-pane.tsx:11-11` (new)",
    );
    expect(text).toContain("```\nconst b = 2;\n```");
    expect(text).toContain("— rename b");
    expect(text).not.toContain('> "const b = 2;"');
  });

  it("keeps plain (markdown) comments as a blockquote — backward compatible", () => {
    const plain: ReviewComment = {
      id: "2",
      file: { node: "plan", label: "plan.md" },
      quote: "quoted text",
      note: "fix this",
    };
    const text = formatReviewComments([plain]);
    expect(text).toContain('> "quoted text"');
    expect(text).toContain("— fix this");
    expect(text).not.toContain("```");
  });
});
