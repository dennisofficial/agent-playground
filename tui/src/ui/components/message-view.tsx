import React from "react";
import { attachmentExpandKey } from "../../domain/attachments.js";
import type { Message, ToolResultPayload } from "../../domain/message.js";
import { EHit, hitKey } from "../../domain/tool-group.js";
import { presentTool } from "../../domain/tool-view.js";
import { delegateFor, type Delegates } from "../../domain/delegates.js";
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
  /** Reading width, needed by every block that draws columns or wraps prose. */
  width?: number;
  /** Relativises a tool's path against the project. See `presentTool`. */
  cwd?: string;
  /**
   * The thread's live delegate index. A tool call that spawned a subagent draws its progress from
   * here; every other block ignores it. Live-only — a reopened transcript has none, which is correct:
   * the delegate's report is its tool result, and that IS persisted.
   */
  delegates?: Delegates;
  /** Ticking clock for a running delegate's elapsed counter. */
  now?: number;
}): React.ReactNode {
  const payload = props.message.payload;
  switch (payload.type) {
    case EMessageType.user:
      return (
        <UserBlock
          text={payload.text}
          {...(props.width === undefined ? {} : { width: props.width })}
        />
      );
    case EMessageType.assistant:
      return (
        <AssistantBlock
          text={payload.text}
          {...(payload.interrupted ? { interrupted: true } : {})}
        />
      );
    case EMessageType.thinking: {
      // Expandable under the same rule as a tool group, keyed like one: `hitKey` namespaces it away
      // from a `toolUseId` so the two share one expansion set without colliding.
      const key = hitKey(EHit.message, props.message.id);
      return (
        <ThinkingBlock
          text={payload.text}
          expanded={props.expandedTools?.has(key) ?? false}
          {...(props.onToggleTool ? { onToggle: () => props.onToggleTool?.(key) } : {})}
          {...(props.width === undefined ? {} : { width: props.width })}
        />
      );
    }
    case EMessageType.tool_call: {
      const result = props.toolResults?.get(payload.toolUseId);
      const isExpanded = props.expandedTools?.has(payload.toolUseId) ?? false;
      // Re-derived at draw time off the stored `input`, not read from the stored `target`: that is
      // what lets a Bash call show its DESCRIPTION and an `mcp__atlas__*` name lose its prefix in a
      // transcript written before either rule existed. See `tool-view.ts`.
      const view = presentTool({
        name: payload.name,
        input: payload.input,
        cwd: props.cwd ?? "",
        ...(result ? { result } : {}),
      });
      const delegate = props.delegates
        ? delegateFor(props.delegates, payload.toolUseId)
        : undefined;
      return (
        <ToolBlock
          name={view.name}
          toolUseId={payload.toolUseId}
          {...(delegate ? { delegate } : {})}
          {...(props.now === undefined ? {} : { now: props.now })}
          {...(view.target ? { target: view.target } : {})}
          command={view.command}
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
          {...(props.onToggleTool
            ? {
                onToggle: () =>
                  props.onToggleTool?.(attachmentExpandKey(props.message.id)),
              }
            : {})}
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
