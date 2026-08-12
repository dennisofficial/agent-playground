import { TextAttributes } from "@opentui/core";
import React from "react";
import type { DiffHunk } from "../../../domain/tool-diff.js";
import { truncate } from "../../../domain/truncate.js";
import { glyph, theme } from "../../theme.js";
import { DiffView } from "./diff-view.js";

/** What a diff sizes itself to when the block is drawn outside a measured transcript (tests). */
const DEFAULT_WIDTH = 80;

export function ToolCallLine(props: {
  name: string;
  target?: string;
}): React.ReactNode {
  return (
    <text>
      {/* Two columns of nothing where the expandable variant puts its ▶, so a tool call sits at the
          same indent whether or not it has detail, and `⎿` hangs under the name in both. */}
      {"  "}
      <span attributes={TextAttributes.BOLD}>{props.name}</span>
      {props.target ? <span>({props.target})</span> : null}
    </text>
  );
}

export function ToolResultLine(props: {
  ok: boolean;
  summary: string;
  detail: string[];
  expanded?: boolean;
}): React.ReactNode {
  const { shown, notice } = props.expanded
    ? { shown: props.detail, notice: null }
    : truncate(props.detail);

  return (
    <box flexDirection="column">
      <text>
        {"  "}
        <span fg={theme.dim}>{glyph.result}</span>
        {"  "}
        <span fg={props.ok ? undefined : theme.error}>{props.summary}</span>
      </text>
      {shown.map((line, index) => (
        <text key={index} fg={theme.dim}>
          {"     "}
          {line}
        </text>
      ))}
      {notice ? (
        <text fg={theme.dim}>
          {"     "}
          {notice}
        </text>
      ) : null}
    </box>
  );
}

export function ToolBlock(props: {
  name: string;
  toolUseId: string;
  target?: string;
  result?: {
    ok: boolean;
    summary: string;
    detail: string[];
    diff?: DiffHunk[];
  };
  /** The transcript's reading width, so a diff can size its gutter and clip its rows. */
  width?: number;
  expanded?: boolean;
  onToggle?: (toolUseId: string) => void;
}): React.ReactNode {
  const hasDetail = props.result && props.result.detail.length > 0;
  const expandIndicator = hasDetail ? (props.expanded ? "▼" : "▶") : " ";
  // A diff shows without being asked. It is the answer to "what did that edit do?", which is a
  // question the reader always has and the summary line structurally cannot answer; every other
  // kind of tool detail is output they can go and look at if they want it.
  const diff = props.result?.diff;

  return (
    <box flexDirection="column" marginBottom={1}>
      <text>
        <span fg={hasDetail ? theme.dim : undefined}>{expandIndicator} </span>
        <span attributes={TextAttributes.BOLD}>{props.name}</span>
        {props.target ? <span>({props.target})</span> : null}
      </text>
      {props.result ? (
        <box flexDirection="column">
          <text>
            {"  "}
            <span fg={theme.dim}>{glyph.result}</span>
            {"  "}
            <span fg={props.result.ok ? undefined : theme.error}>
              {props.result.summary}
            </span>
          </text>
          {diff && diff.length > 0 ? (
            <DiffView
              hunks={diff}
              width={props.width ?? DEFAULT_WIDTH}
              expanded={props.expanded ?? false}
            />
          ) : props.expanded ? (
            props.result.detail.map((line, index) => (
              <text key={index} fg={theme.dim}>
                {"     "}
                {line}
              </text>
            ))
          ) : null}
        </box>
      ) : null}
    </box>
  );
}

/** A running tool keeps its `⏺` and gains a spinner in the RESULT gutter, so a long tool never
 *  looks like a hang. */
export function ToolRunningLine(props: {
  frame: string;
  elapsed: string;
  lines: string[];
}): React.ReactNode {
  return (
    <box flexDirection="column">
      <text>
        {"  "}
        <span fg={theme.dim}>{glyph.result}</span>
        {"  "}
        <span fg={theme.accent}>{props.frame}</span>
        <span fg={theme.dim}> running… {props.elapsed}</span>
      </text>
      {props.lines.slice(-3).map((line, index) => (
        <text key={index} fg={theme.dim}>
          {"     "}
          {line}
        </text>
      ))}
    </box>
  );
}
