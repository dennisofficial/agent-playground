import { useRenderer } from "@opentui/react";
import React, { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../clipboard.js";
import { glyph, theme } from "../theme.js";

/** How long the button admits to having done something before going quiet again. */
const CONFIRM_MS = 1500;

const LABELS = {
  idle: `${glyph.copy} copy`,
  copied: `${glyph.copy} copied`,
  failed: `${glyph.copy} blocked`,
} as const;

export const COPY_BUTTON_WIDTH =
  Math.max(...Object.values(LABELS).map((label) => label.length)) + 2;

export function CopyButton(props: {
  text: string;
  pad?: string;
  /**
   * Whether the button is drawing itself. Defaults to always, for the call sites that live in a
   * footer of their own and have nothing to be an eyesore on top of.
   */
  revealed?: boolean;
}): React.ReactNode {
  const renderer = useRenderer();
  const [state, setState] = useState<keyof typeof LABELS>("idle");
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = (): void => {
    setState(copyToClipboard(renderer, props.text) ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), CONFIRM_MS);
  };

  // Hover only recolours the resting state: `copied` and `ok` green already say more than "you are
  // pointing at this", and overriding them would lose the one report the button makes.
  const fg =
    state === "failed"
      ? theme.warn
      : state === "copied"
        ? theme.ok
        : hovered
          ? theme.hover
          : theme.dim;

  // A report outlives the pointer. Copying on the way out of a block would otherwise hide the label
  // in the same breath it changed, and the click would look like it did nothing — so anything other
  // than `idle` keeps the button on screen for its confirm window regardless of where the mouse is.
  const shown = (props.revealed ?? true) || state !== "idle";
  const label = shown ? ` ${LABELS[state]} ` : "";

  // Hidden is not absent: the button holds its columns either way and fills them with whatever it is
  // padded with — the fence's own border. Dropping the width instead would move the block's corner
  // the moment the pointer arrived, reflowing the thing being pointed at.
  //
  // The padding is a SEPARATE renderable from the label, and the only thing that buys is honesty
  // about what is being pointed at: drawn as one string, hovering lights the border dashes too, and
  // the button appears to extend into the fence's edge. The pad stays border-coloured and inert; the
  // label is the button.
  return (
    <box flexDirection="row" width={COPY_BUTTON_WIDTH} flexShrink={0}>
      <text fg={theme.dim}>
        {(props.pad ?? " ").repeat(
          Math.max(0, COPY_BUTTON_WIDTH - label.length),
        )}
      </text>
      {shown ? (
        <text
          fg={fg}
          onMouseDown={copy}
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
        >
          {label}
        </text>
      ) : null}
    </box>
  );
}
