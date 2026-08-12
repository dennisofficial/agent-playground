import type { ScrollBoxRenderable } from "@opentui/core";
import React, { type RefObject } from "react";
import type { ToolResultPayload } from "../../domain/message.js";
import type { TranscriptItem } from "../../domain/seam.js";
import type { ConversationState } from "../../app/conversation.store.js";
import { AssistantBlock } from "./blocks/assistant-block.js";
import { SessionSeam, SwapNotice } from "./blocks/error-block.js";
import { NewDivider, UNSEEN_ANCHOR_ID } from "./new-divider.js";
import { ThinkingBlock } from "./blocks/thinking-block.js";
import { ToolRunningLine } from "./blocks/tool-block.js";
import { MessageView } from "./message-view.js";
import { WorkingLine } from "./working-line.js";
import { formatElapsed, theme, TRANSCRIPT_PADDING } from "../theme.js";

/** The seam rule is measured, not styled: a rule wider than the reading column stops being a seam. */
const SEAM_MAX = 72;

/**
 * Everything above the composer: the committed transcript, then the parts of the CURRENT turn that
 * are not committed yet — the live tail, the running tool, the working line. The order is the order
 * they happen in, which is why they are appended here rather than composed into the message list:
 * none of them is a message, and two of them will never become one.
 */
export function Transcript(props: {
  items: TranscriptItem[];
  itemKeys: string[];
  state: ConversationState;
  toolResults: Map<string, ToolResultPayload>;
  expandedTools: Set<string>;
  onToggleTool: (toolUseId: string) => void;
  /** Ticking clock, so the elapsed counters advance without the transcript re-deriving. */
  now: number;
  frame: string;
  cwd: string;
  width: number;
  /** The page holds this so it can ask where the transcript is — see `useReadState`. */
  scroller?: RefObject<ScrollBoxRenderable | null>;
  /** The oldest message you have not seen: where opening the thread lands. */
  anchorMessageId?: string | null;
  showDivider?: boolean;
}): React.ReactNode {
  const { state } = props;
  return (
    <scrollbox
      ref={props.scroller}
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      focusable={false}
      stickyScroll
      stickyStart="bottom"
      viewportCulling
      // The padding goes on the CONTENT box, not the scrollbox: padding on the scrollbox itself
      // insets the scrollbar along with the text, which just moves the collision. See
      // `TRANSCRIPT_PADDING`.
      contentOptions={{ paddingRight: TRANSCRIPT_PADDING }}
    >
      {props.items.map((item, index) => {
        // The anchor is hung on a message, never on the rule: a thread you have never opened has
        // everything unseen and so draws no rule, and it still has to land somewhere.
        const anchored =
          item.kind !== "seam" && item.message.id === props.anchorMessageId;
        return (
          <box
            key={props.itemKeys[index] ?? String(index)}
            flexDirection="column"
            {...(anchored ? { id: UNSEEN_ANCHOR_ID } : {})}
          >
            {anchored && props.showDivider ? (
              <NewDivider width={props.width} />
            ) : null}
            {item.kind === "seam" ? (
              <SessionSeam
                ordinal={item.ordinal}
                endReason={item.endReason}
                width={Math.min(props.width, SEAM_MAX)}
              />
            ) : (
              <MessageView
                message={item.message}
                width={props.width}
                toolResults={props.toolResults}
                expandedTools={props.expandedTools}
                onToggleTool={props.onToggleTool}
              />
            )}
          </box>
        );
      })}

      {state.messages.length === 0 && !state.running ? (
        <box flexDirection="column" marginBottom={1}>
          <text fg={theme.dim}>{props.cwd}</text>
          <text> </text>
          <text fg={theme.dim}>Describe the work, or / for commands.</text>
        </box>
      ) : null}

      {state.notices.map((notice, index) => (
        <SwapNotice key={index} text={notice} />
      ))}

      {state.tail?.kind === "text" ? (
        <AssistantBlock text={state.tail.text} streaming />
      ) : null}
      {state.tail?.kind === "thinking" ? (
        <ThinkingBlock text={state.tail.text} streaming />
      ) : null}

      {state.runningTool ? (
        <ToolRunningLine
          frame={props.frame}
          elapsed={formatElapsed(props.now - state.runningTool.startedAt)}
          lines={state.runningTool.lines}
        />
      ) : null}

      {/* Running, or the last turn's summary in the same place — the line does not move when a turn
          ends, so the number you were watching stays where you were watching it. */}
      {state.running && state.startedAt !== null ? (
        <box flexDirection="row" marginTop={1} marginBottom={1}>
          <WorkingLine
            running
            elapsedMs={props.now - state.startedAt}
            frame={props.frame}
            outputTokens={state.outputTokens}
            queued={state.queued}
            interrupting={state.interrupting}
          />
        </box>
      ) : state.lastTurn ? (
        <box flexDirection="row" marginTop={1} marginBottom={1}>
          <WorkingLine
            running={false}
            elapsedMs={state.lastTurn.durationMs}
            frame={props.frame}
            outputTokens={state.lastTurn.outputTokens}
            queued={state.queued}
            interrupting={false}
          />
        </box>
      ) : null}
    </scrollbox>
  );
}
