"use client";

import { bridgeToolLabel } from "../constants";
import type { ToolHandler, ToolItem } from "../types";
import { argsOf, formatPayload, isBridgeTool, mcpName } from "../util";
import { StructuredPanel } from "../ui";

function BridgeBody({ tool }: { tool: ToolItem }) {
  const input = formatPayload(argsOf(tool.input));
  return (
    <StructuredPanel
      input={input}
      result={formatPayload(tool.result)}
      isError={tool.isError}
      superseded={tool.superseded}
    />
  );
}

/**
 * Atlas host-bridge tools (`mcp__atlas-host-bridge__*`) — propose_plan, ask_question, recall, … —
 * rendered with a friendly label and a structured input/result panel.
 */
export const mcpBridgeHandler: ToolHandler = {
  id: "mcp-bridge",
  match: (name) => isBridgeTool(name),
  describe: (tool) => {
    const bare = mcpName(tool.name);
    // `bare` is an arbitrary tool-name string; bridgeToolLabel does the safe lookup + raw fallback.
    const label = bridgeToolLabel(bare);
    return {
      icon: "mcp",
      label: "",
      arg: label,
      preview: label,
      color: "var(--blue)",
      isMcp: true,
      badge: tool.isError ? { kind: "error" } : null,
    };
  },
  Body: BridgeBody,
};
