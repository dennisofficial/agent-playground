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

  const label = ` ${LABELS[state]} `;

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
      <text
        fg={fg}
        onMouseDown={copy}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
      >
        {label}
      </text>
    </box>
  );
}
