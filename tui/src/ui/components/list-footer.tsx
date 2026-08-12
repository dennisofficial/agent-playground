import React from "react";
import type { EditorState } from "../../domain/text-editor.js";
import { fitHints } from "../../domain/hints.js";
import { overlayWidth } from "../../domain/list-columns.js";
import { Composer } from "./composer.js";
import { ListShortcuts } from "./shortcuts.js";
import { theme } from "../theme.js";

/** The composer a mode borrows the footer for — filtering, naming a job, typing a path. */
export type FooterOverlay = {
  state: EditorState;
  placeholder: string;
  /** The line under the box: what ⏎ does here, and how to get out. */
  caption: string;
  onCaret: (index: number) => void;
};

/**
 * The footer every list page draws. The three list pages had this block copied between them, which
 * is how they drifted: the same overlay was two columns narrower on one page than the next, and a
 * fix to one never reached the others.
 *
 * Deliberately dumb — it renders what the page's mode already decided. The arbitration of WHICH of
 * these is showing stays on the page, because that is the page's keyboard contract.
 */
export function ListFooter(props: {
  width: number;
  height: number;
  overlay?: FooterOverlay | undefined;
  /**
   * A `VerbMenu`, when the page is offering a choice. Separate from `confirm` because the two are
   * different questions — one picks, the other agrees — and a page can only ever be asking one.
   */
  menu?: React.ReactNode;
  /** A `ConfirmBar`, when the page is asking. */
  confirm?: React.ReactNode;
  /** Longest-first forms; the widest that fits wins. Absent while a mode owns the footer. */
  hints?: readonly string[] | undefined;
  shortcuts: boolean;
  error: string | null;
}): React.ReactNode {
  return (
    <box flexDirection="column">
      {props.overlay ? (
        <box flexDirection="column">
          <Composer
            state={props.overlay.state}
            width={overlayWidth(props.width)}
            placeholder={props.overlay.placeholder}
            onCaret={props.overlay.onCaret}
          />
          <text fg={theme.dim}>
            {"  "}
            {props.overlay.caption}
          </text>
        </box>
      ) : null}

      {props.menu ?? null}
      {props.confirm ?? null}

      {props.hints ? (
        props.shortcuts ? (
          <ListShortcuts width={props.width} height={props.height} />
        ) : (
          <text fg={theme.dim}>{fitHints(props.width, [...props.hints])}</text>
        )
      ) : null}

      {props.error ? (
        <text fg={theme.error}>
          {"  "}
          {props.error}
        </text>
      ) : null}
    </box>
  );
}
