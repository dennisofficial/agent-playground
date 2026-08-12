import { useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useEffect, useState } from "react";
import { fitHints } from "../../domain/hints.js";
import { Composer, composerRows } from "../components/composer.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { useComposer } from "../hooks/use-composer.js";
import { useInput } from "../hooks/use-input.js";
import { theme } from "../theme.js";

/**
 * A job before it exists.
 *
 * There is no title prompt and no form: `n` lands here, on an empty composer, and the page holds
 * nothing but a draft. **Every byte of a pending job is this component's state** — walk away and
 * React unmounts it and the job never happened, with no row to clean up, no context folder on disk
 * and no worktree to release. That is why the creation itself is a callback rather than a service
 * this page holds: a page that could write is a page that might.
 *
 * The first message is not a description of the job, it IS the job's first message — so this
 * composer is the conversation's composer, multi-line and modifier-aware, not a one-line field.
 */
export function NewJobPage(props: {
  projectName: string;
  /** Creates the job and navigates away. Resolves without leaving only if creation failed. */
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
}): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const composer = useComposer();
  const [sending, setSending] = useState(false);
  // Esc is one keystroke away from a paragraph you meant to send, so discarding a draft asks twice —
  // the same rule the conversation composer follows. Armed is a moment, not a mode.
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  const handleSubmit = useCallback(async () => {
    const text = composer.value.trim();
    if (text.length === 0) return;
    setSending(true);
    await props.onSubmit(text);
    // Only reached when creation failed: the success path replaces this page out from under us, and
    // a setState on an unmounted component is a no-op. Failing here has to leave the draft typeable
    // again, or the words you just wrote are trapped on a dead page.
    setSending(false);
  }, [composer, props]);

  useInput((input, key) => {
    // The job is being created. Nothing here can be un-pressed, and a second Return would be a
    // second job.
    if (sending) return;

    if (key.escape) {
      if (composer.value.trim().length === 0 || armed) return props.onCancel();
      setArmed(true);
      return;
    }
    // Any other key means you are still writing — a warning left standing would make a later,
    // innocent esc an unwarned discard.
    if (armed) setArmed(false);

    // `←` on an empty composer is back, exactly as it is in a real conversation.
    if (key.leftArrow && composer.value.length === 0) return props.onCancel();

    // Plain Return sends. Return with ANY modifier falls through as a newline — a first message is
    // often a paragraph, and this is where it gets written.
    if (key.return && !key.shift && !key.meta && !key.ctrl) {
      void handleSubmit();
      return;
    }

    composer.handleKey(input, key);
  });

  return (
    <Screen
      header={
        <PageHeader trail={["atlas", props.projectName, "new job"]} canBack />
      }
      footer={
        <box flexDirection="column">
          <Composer
            state={composer.state}
            width={width}
            maxRows={composerRows(height)}
            placeholder="what do you want to do?"
            onCaret={composer.setCursor}
          />
          <text fg={theme.dim}>
            {fitHints(
              width,
              hintForms({ armed, sending, draft: composer.value.length }),
            )}
          </text>
        </box>
      }
    >
      {/* Said once, quietly, and only here: the reassurance is the whole reason this page can be
          entered on a reflex. It is what makes `n` cost nothing. */}
      <text fg={theme.dim}>
        Nothing is saved until you send. Your first message starts the job and
        names it.
      </text>
    </Screen>
  );
}

/** Longest-first, as everywhere: the widest form that fits wins. */
function hintForms(state: {
  armed: boolean;
  sending: boolean;
  draft: number;
}): string[] {
  if (state.sending) return ["starting…"];
  if (state.armed)
    return ["esc again to discard — nothing has been saved", "esc again to discard"];
  if (state.draft > 0)
    return ["⏎ send · ⇧⏎ new line · esc discard", "⏎ send · esc discard"];
  return ["⏎ send · ←/esc back · ⇧⏎ new line", "⏎ send · esc back"];
}
