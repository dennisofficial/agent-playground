import React from "react";
import type { Message, ToolResultPayload } from "../../domain/message.js";
import { EMessageType } from "../../generated/prisma/enums.js";
import { AssistantBlock } from "./blocks/assistant-block.js";
import { ErrorBlock } from "./blocks/error-block.js";
import { ThinkingBlock } from "./blocks/thinking-block.js";
import { ToolBlock } from "./blocks/tool-block.js";
import { UserBlock } from "./blocks/user-block.js";

export function MessageView(props: {
  message: Message;
  toolResults?: Map<string, ToolResultPayload>;
  expandedTools?: Set<string>;
  onToggleTool?: (toolUseId: string) => void;
}): React.ReactNode {
  const payload = props.message.payload;
  switch (payload.type) {
    case EMessageType.user:
      return <UserBlock text={payload.text} />;
    case EMessageType.assistant:
      return (
        <AssistantBlock
          text={payload.text}
          {...(payload.interrupted ? { interrupted: true } : {})}
        />
      );
    case EMessageType.thinking:
      return <ThinkingBlock text={payload.text} />;
    case EMessageType.tool_call: {
      const result = props.toolResults?.get(payload.toolUseId);
      const isExpanded = props.expandedTools?.has(payload.toolUseId) ?? false;
      return (
        <ToolBlock
          name={payload.name}
          toolUseId={payload.toolUseId}
          {...(payload.target ? { target: payload.target } : {})}
          {...(result
            ? {
                result: {
                  ok: result.ok,
                  summary: result.summary,
                  detail: result.detail,
                },
              }
            : {})}
          expanded={isExpanded}
          onToggle={props.onToggleTool}
        />
      );
    }
    case EMessageType.tool_result:
      // Tool results are rendered inline with their tool_call — skip standalone rendering.
      // If there's no paired call (orphan result), fall through and render nothing.
      return null;
    case EMessageType.error:
      return (
        <ErrorBlock
          title={payload.title}
          {...(payload.detail ? { detail: payload.detail } : {})}
          {...(payload.retryable ? { retryable: true } : {})}
        />
      );
  }
}
