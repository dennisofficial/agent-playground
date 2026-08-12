import React from "react";
import type { AttachmentPart } from "../../domain/attachments.js";
import { fitHints } from "../../domain/hints.js";
import {
  proposalKeyHints,
  reviewSummary,
  type ProposalView,
} from "../../domain/transition-review.js";
import type { ProposalControls } from "../hooks/use-proposal.js";
import { MarkdownView } from "../markdown/markdown-view.js";
import { glyph, theme } from "../theme.js";

/** The overlay's own two columns of inset, matching the confirm bar it sits in place of. */
const INDENT = "  ";
const INSET = 4;

/** How many rows the review may take before it scrolls. A third of the screen, like the keymap. */
export function reviewRows(height: number): number {
  return Math.max(4, Math.floor(height / 3));
}

/**
 * Everything a pending proposal puts in the footer — the ask, the way back to it, and the one line
 * that follows a decline. Three states of one thing, kept together so the page mounts it as one.
 */
export function ProposalFooter(props: {
  proposal: ProposalControls;
  width: number;
  height: number;
}): React.ReactNode {
  const { proposal } = props;

  return (
    <box flexDirection="column">
      {/* The whole map's last link: an agent asked to move the job on, and this is where it is
          answered. */}
      {proposal.open && proposal.view ? (
        <TransitionConfirm
          view={proposal.view}
          parts={proposal.parts}
          expanded={proposal.expanded}
          width={props.width}
          maxRows={reviewRows(props.height)}
          busy={proposal.busy}
          error={proposal.error}
        />
      ) : null}

      {/* Pushed away, or held back because there is a draft in the composer. It spells its own key
          for the reason `JumpToBottom` does: the keyboard belongs to the draft here, so a binding
          nobody can see is a secret — and the keymap panel has no row to spare for it. */}
      {proposal.waiting ? (
        <text fg={theme.warn}>
          {INDENT}
          {glyph.warning} a phase advance is waiting on you · ctrl+y to review
        </text>
      ) : null}

      {/* Declining writes the row and does nothing else on purpose, so this line is what stops `n`
          looking inert: the thread is still open, and the composer below is where you say why. */}
      {!proposal.open && proposal.notice ? (
        <text fg={theme.dim}>
          {INDENT}
          {proposal.notice}
        </text>
      ) : null}
    </box>
  );
}

/**
 * A phase advance, waiting on one keypress.
 *
 * **Yes or no, and no destination picker** (design 22 §5): an editable target would make the row
 * ambiguous about what was proposed versus what was chosen, and the declined rows are the only
 * evidence that would later say a trigger is mistuned. There is no `awaiting_approval` state either
 * — this overlay IS plan approval and IS the ship button, differing only in whether the proposal
 * carries artifacts (design 02 §3).
 *
 * Drawn above the composer, in the footer, where every other "you are being asked something" already
 * lives. Not a modal: it is one keypress in a loop that costs a keypress a lap by design, and a
 * dialog for it would be three.
 */
export function TransitionConfirm(props: {
  view: ProposalView;
  /** The attached files with their bodies — what `y` will hand the successor. */
  parts: readonly AttachmentPart[];
  /** Whether the hand-off and the documents are showing. See `opensAsReview`. */
  expanded: boolean;
  width: number;
  /** The rows the review may occupy before it scrolls. See `reviewRows`. */
  maxRows: number;
  /** Mid-confirm: the phase is being created, which involves disk and a turn starting. */
  busy?: boolean;
  /** Another terminal answered first, most often — see `requirePending`. */
  error?: string | null;
  /** Said once, after `n`, because declining deliberately does nothing else. */
  notice?: string | null;
}): React.ReactNode {
  const { view } = props;
  // Explicit, and never `flexGrow`: the reason and the documents are arbitrary agent prose, and a
  // markdown block with no width to lay out against escapes the footer and takes the page with it.
  const columns = Math.max(20, props.width - INSET);
  const hasDocuments = view.handoff.length > 0 || props.parts.length > 0;

  return (
    <box flexDirection="column" width={props.width} flexShrink={0}>
      <text fg={theme.warn}>
        {INDENT}
        {glyph.warning} confirm this phase advance · {view.route}
      </text>

      {/* The agent's own prose, written FOR Dennis — the headline, and the only line he must read
          before deciding. Rendered as markdown because that is what an agent writes. */}
      <box flexDirection="column" width={columns} flexShrink={0} marginLeft={INSET}>
        <MarkdownView source={view.reason} width={columns} />
      </box>

      {props.expanded ? (
        <ProposalDocuments
          view={view}
          parts={props.parts}
          width={columns}
          maxRows={props.maxRows}
        />
      ) : (
        <text fg={theme.dim}>
          {INDENT}
          {INDENT}
          {reviewSummary({ handoff: view.handoff, files: view.files })}
        </text>
      )}

      {props.notice ? (
        <text fg={theme.dim}>
          {INDENT}
          {props.notice}
        </text>
      ) : null}
      {props.error ? (
        <text fg={theme.error}>
          {INDENT}
          {props.error}
        </text>
      ) : null}

      <text fg={theme.dim}>
        {INDENT}
        {props.busy
          ? "confirming…"
          : fitHints(props.width - INDENT.length, [
              ...proposalKeyHints({ expanded: props.expanded, hasDocuments }),
            ])}
      </text>
    </box>
  );
}

/**
 * What the successor will open with: the hand-off, then every file crossing the boundary, in full.
 *
 * On a build boundary these ARE the specs, which is what makes `y` plan approval rather than a
 * shrug — a plan confirmed unread is the failure the confirm rule exists to prevent. **Atlas parses
 * none of it**: the files are rendered, and the agent's prose above says what is done and what is
 * not. Nothing here reads a heading or counts a slice.
 *
 * The scrollbox is bounded in BOTH axes — height here, width on every child — because a spec runs to
 * pages and a footer that sizes to its content would push the composer off the screen. It is not
 * focusable: the keyboard belongs to the decision, and the wheel drives this.
 */
function ProposalDocuments(props: {
  view: ProposalView;
  parts: readonly AttachmentPart[];
  width: number;
  maxRows: number;
}): React.ReactNode {
  return (
    <scrollbox
      flexShrink={0}
      focusable={false}
      height={props.maxRows}
      width={props.width}
      marginLeft={INSET}
    >
      {props.view.handoff.length > 0 ? (
        <box flexDirection="column" width={props.width} flexShrink={0}>
          <text fg={theme.dim}>hand-off</text>
          <MarkdownView source={props.view.handoff} width={props.width} />
        </box>
      ) : null}

      {props.parts.map((part, index) => (
        <box
          key={index}
          flexDirection="column"
          width={props.width}
          flexShrink={0}
        >
          {/* A file that has been tidied away since the proposal keeps its name in red rather than
              vanishing: what the seam WILL hand over is exactly what a silent drop would cost. */}
          <text fg={part.body === null ? theme.error : theme.dim}>
            {glyph.result} {part.label}
            {part.body === null ? " — MISSING" : ` (${part.lines} lines)`}
          </text>
          {part.body === null ? null : (
            <MarkdownView source={part.body} width={props.width} />
          )}
        </box>
      ))}
    </scrollbox>
  );
}
