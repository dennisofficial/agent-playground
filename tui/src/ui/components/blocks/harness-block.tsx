import React from "react";
import { EHarnessVariant } from "../../../domain/message.js";
import { glyph, theme } from "../../theme.js";

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

/**
 * Atlas speaking, rendered so it can never be mistaken for Dennis.
 *
 * Deliberately unlike both neighbours: no warm slab (that is the user's, and finding "where did I
 * last speak" by colour is exactly what a harness message must not steal), no accent `⏺` (that is
 * the agent's). A dim rule and a named source instead — Atlas is transparent about what it injects,
 * and the reader should be able to skip it at a glance yet never wonder who wrote it.
 *
 * The text renders VERBATIM rather than as markdown: this is the byte-for-byte instruction the model
 * was given, and restyling it would put the transcript one step further from what actually happened.
 */
export function HarnessBlock(props: {
  variant: EHarnessVariant;
  text: string;
}): React.ReactNode {
  // A row written by another build can carry a variant this one has never heard of. It is still a
  // harness message and still worth showing — the label falls back to what was stored.
  const label = LABELS[props.variant] ?? props.variant;

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.dim}>
        {glyph.harness} atlas · {label}
      </text>
      {props.text.split("\n").map((line, index) => (
        <text key={index}>
          <span fg={theme.dim}>{glyph.harness} </span>
          {line}
        </text>
      ))}
    </box>
  );
}
