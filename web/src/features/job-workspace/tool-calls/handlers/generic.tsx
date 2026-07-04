"use client";

import type { ToolHandler, ToolItem } from "../types";
import { formatPayload, mcpName } from "../util";
import { StructuredPanel } from "../ui";

function GenericBody({ tool }: { tool: ToolItem }) {
  return (
    <StructuredPanel
      input={formatPayload(tool.input)}
      result={formatPayload(tool.result)}
      isError={tool.isError}
    />
  );
}

/**
 * Fallback for any tool not claimed by a specific handler — other MCP servers, future native tools.
 * Renders as a blue `mcp · name` row with a structured input/result panel. Matches everything, so it
 * MUST be registered last.
 */
export const genericHandler: ToolHandler = {
  id: "generic",
  match: () => true,
  describe: (tool: ToolItem) => {
    const n = mcpName(tool.name);
    return {
      icon: "mcp",
      label: "",
      arg: n,
      preview: n,
      color: "var(--blue)",
      isMcp: true,
      badge: tool.isError ? { kind: "error" } : null,
    };
  },
  Body: GenericBody,
};
