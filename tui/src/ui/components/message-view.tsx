import React from "react";
import { attachmentExpandKey } from "../../domain/attachments.js";
import type { Message, ToolResultPayload } from "../../domain/message.js";
import { EMessageType } from "../../generated/prisma/enums.js";
import { AssistantBlock } from "./blocks/assistant-block.js";
import { ErrorBlock } from "./blocks/error-block.js";
import { HarnessBlock } from "./blocks/harness-block.js";
import { ThinkingBlock } from "./blocks/thinking-block.js";
import { ToolBlock } from "./blocks/tool-block.js";
import { UserBlock } from "./blocks/user-block.js";

export function MessageView(props: {
  message: Message;
  toolResults?: Map<string, ToolResultPayload>;
  expandedTools?: Set<string>;
  onToggleTool?: (toolUseId: string) => void;
  /** Reading width, needed only by the blocks that draw columns — today, an edit's diff. */
  width?: number;
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
                  ...(result.diff ? { diff: result.diff } : {}),
                },
              }
            : {})}
          {...(props.width === undefined ? {} : { width: props.width })}
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
    case EMessageType.harness:
      return (
        <HarnessBlock
          variant={payload.variant}
          text={payload.text}
          {...(payload.attachments
            ? { attachments: payload.attachments }
            : {})}
          // Attachments share the transcript's ONE expansion set, under a namespaced key: to a
          // reader, opening a file chip and opening a tool result are the same gesture, and two
          // mechanisms for it would mean two keys to remember. Per MESSAGE rather than per chip —
          // a hand-off's files are one thing you either wanted to read or did not.
          expanded={
            props.expandedTools?.has(attachmentExpandKey(props.message.id)) ??
            false
          }
          {...(props.width === undefined ? {} : { width: props.width })}
        />
      );
    default: {
      // The render map is exhaustive BY CONSTRUCTION: `payload` narrows to `never` only while every
      // member of the union has a case above, so a new message type fails to compile here rather
      // than rendering as a silent blank in someone's transcript. `ReactNode` includes `undefined`,
      // so falling off the end of the switch would otherwise typecheck.
      const unrendered: never = payload;
      return unrendered;
    }
  }
}
