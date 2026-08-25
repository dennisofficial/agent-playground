import { useTerminalDimensions } from "@opentui/react";
import React from "react";
import type { AttachmentPart } from "../../../domain/attachments.js";
import { stripCanary } from "../../../domain/canary.js";
import { EHarnessVariant } from "../../../domain/message.js";
import { MarkdownView } from "../../markdown/markdown-view.js";
import { theme, TRANSCRIPT_INSET } from "../../theme.js";
import { AttachmentChips } from "./attachment-chips.js";

/**
 * What each variant is called on screen. The renderer switches on the VARIANT — that is the whole
 * reason variants live in the payload — but the switch is a label table rather than four layouts,
 * because they differ in what they are for, not in how they should be read.
 *
 * `seed` reads as "brief": the word describes what the agent is looking at, where `seed` describes
 * how it got there.
 */
const LABELS: Record<EHarnessVariant, string> = {
  [EHarnessVariant.seed]: "brief",
  [EHarnessVariant.handoff]: "handoff",
  [EHarnessVariant.transition]: "transition",
  [EHarnessVariant.notice]: "notice",
};

/** The accent rule down the left edge of the slab. One column, the whole height of the block. */
const STRIPE = 1;
/** A column of air either side of the prose, so text never sits flush against the rule. */
const PAD = 1;
const RESERVED = STRIPE + PAD * 2 + TRANSCRIPT_INSET;

/**
 * Atlas speaking, rendered so it can never be mistaken for Dennis.
 *
 * A slab, like the user's turns, because the question "who said this" has to be answerable before a
 * word is read and a hand-off can run for pages. What tells the two apart is HUE, not weight — see
 * `theme.harnessBg`: the accent's own hue at slab darkness against the user's near-neutral warm
 * grey, with the accent itself as a rule down the left edge. That rule used to be a `┃` prefixed to
 * every line, which is what forced the body to be a column of hand-drawn lines; as the slab's edge it
 * says the same thing and leaves the body free to be laid out.
 *
 * The text renders as MARKDOWN. Verbatim was the earlier call — this is the byte-for-byte
 * instruction the model was given, and restyling it puts the transcript a step away from what
 * happened — but a brief and a hand-off are written in markdown by the thing that composes them, so
 * verbatim meant the reader paying in `##` and `-` for a fidelity nothing was reading for. Nothing is
 * lost either way: the styling is applied at render, and the row still holds the bytes that were sent.
 */
export function HarnessBlock(props: {
  variant: EHarnessVariant;
  text: string;
  /**
   * The files this message inlined, as the seam stored them. The prose above never contains their
   * bodies — that is the whole point of storing the parts — so this is the only thing on screen that
   * says what the receiving thread was actually handed.
   */
  attachments?: readonly AttachmentPart[];
  expanded?: boolean;
  /** Opens the whole attachment manifest — see `AttachmentChips`. */
  onToggle?: () => void;
  width?: number;
}): React.ReactNode {
  const { width } = useTerminalDimensions();
  // A row written by another build can carry a variant this one has never heard of. It is still a
  // harness message and still worth showing — the label falls back to what was stored.
  const label = LABELS[props.variant] ?? props.variant;
  // A hand-off is prose one agent wrote and another was given, so it can carry the canary in front
  // of it exactly like an assistant block. Stripped for the reader, kept in the store.
  const text = stripCanary(props.text);
  // Markdown has to be handed a hard column: it wraps prose itself, and a fence inside a hand-off
  // decides whether it overflows before it draws. The transcript passes the TERMINAL width, so what
  // the slab actually gives the body is that less its own chrome.
  const columns = Math.max(20, (props.width ?? width) - RESERVED);

  return (
    <box
      flexDirection="row"
      marginBottom={1}
      backgroundColor={theme.harnessBg}
      flexShrink={0}
    >
      <box width={STRIPE} flexShrink={0} backgroundColor={theme.accent} />
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        paddingLeft={PAD}
        paddingRight={PAD}
      >
        {/* The accent, not `dim`: a grey that reads as quiet chrome over the terminal's own
            background reads as unlit over a slab, and the label is the one line that names the
            source. It ties to the rule beside it, which is the same colour. */}
        <text fg={theme.accent} bg={theme.harnessBg}>
          atlas · {label}
        </text>
        <MarkdownView
          source={text}
          width={columns}
          fg={theme.harnessFg}
          bg={theme.harnessBg}
        />
        {props.attachments && props.attachments.length > 0 ? (
          <AttachmentChips
            parts={props.attachments}
            expanded={props.expanded ?? false}
            {...(props.onToggle ? { onToggle: props.onToggle } : {})}
            width={columns}
          />
        ) : null}
      </box>
    </box>
  );
}
