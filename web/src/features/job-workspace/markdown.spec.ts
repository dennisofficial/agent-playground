import { describe, expect, it } from "vitest";
import { extractMermaidSources } from "./markdown";

describe("extractMermaidSources", () => {
  it("extracts and trims a single fenced diagram", () => {
    const text = "before\n```mermaid\nflowchart TD\n  A --> B\n```\nafter";
    expect(extractMermaidSources(text)).toEqual(["flowchart TD\n  A --> B"]);
  });

  it("extracts multiple fences in document order", () => {
    const text = [
      "```mermaid\nflowchart TD\n  A --> B\n```",
      "some prose in between",
      "```mermaid\nsequenceDiagram\n  Alice->>Bob: hi\n```",
    ].join("\n");
    expect(extractMermaidSources(text)).toEqual([
      "flowchart TD\n  A --> B",
      "sequenceDiagram\n  Alice->>Bob: hi",
    ]);
  });

  it("returns an empty array when there are no mermaid fences", () => {
    expect(extractMermaidSources("just plain text, no fences here")).toEqual([]);
  });

  it("ignores non-mermaid fenced code blocks", () => {
    const text = "```ts\nconst a = 1;\n```";
    expect(extractMermaidSources(text)).toEqual([]);
  });
});
