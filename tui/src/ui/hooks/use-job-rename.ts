import { useCallback, useState } from "react";
import type { FooterOverlay } from "../components/list-footer.js";
import { useComposer } from "./use-composer.js";
import type { InputKey } from "./use-input.js";
import { useJobTitle } from "./use-job-title.js";
import { useServices } from "../services.js";

export type JobRenameControls = {
  /** The job's live name — what the page's trail should draw, renamed or not. */
  title: string;
  /** True while the field owns the keyboard. The page's own keys stand down. */
  active: boolean;
  overlay: FooterOverlay | undefined;
  error: string | null;
  begin: () => void;
  /** True when this consumed the key, on the page's first-refusal rule. */
  handleKey: (input: string, key: InputKey) => boolean;
};

/**
 * Renaming a job, as a mode on the job's own page.
 *
 * A mode rather than a page: the title is one line, and a job the titler named "Per-Server Notes"
 * needs a correction that costs one keypress, not a form. It starts PREFILLED — a rename is almost
 * always an edit of what is there, and an empty field would make correcting a title mean retyping
 * it.
 *
 * Apart from the page for the reason `useHumanVerbs` is: what owns the keyboard while it is up is
 * the whole of the behaviour, and reading that with a hundred lines of JSX in between hides it.
 */
export function useJobRename(job: {
  id: string;
  title: string;
}): JobRenameControls {
  const { jobTitleService } = useServices();
  const title = useJobTitle(job);
  const [active, setActive] = useState(false);
  // A name, never a paragraph: one line, and a pasted newline collapses to a space.
  const composer = useComposer("", { singleLine: true });
  const [error, setError] = useState<string | null>(null);

  const begin = useCallback(() => {
    setError(null);
    composer.setValue(title);
    setActive(true);
  }, [composer, title]);

  const leave = useCallback(() => {
    setActive(false);
    composer.clear();
  }, [composer]);

  const commit = useCallback(() => {
    const typed = composer.value;
    leave();
    jobTitleService
      .rename({ jobId: job.id, title: typed })
      // The store publishes, so every header on the stack moves — including the conversation's,
      // one frame up, which is holding a job row read before the rename happened.
      .then(() => setError(null))
      .catch((e: Error) => setError(e.message));
  }, [composer.value, job.id, jobTitleService, leave]);

  const handleKey = useCallback(
    (input: string, key: InputKey): boolean => {
      if (!active) return false;
      if (key.escape) {
        leave();
        return true;
      }
      if (key.return) {
        commit();
        return true;
      }
      // Everything else is typing, including the arrows — the field owns the keyboard outright, or
      // `↑` would move the list underneath while you are correcting a word.
      composer.handleKey(input, key);
      return true;
    },
    [active, commit, composer, leave],
  );

  return {
    title,
    active,
    overlay: active
      ? {
          state: composer.state,
          placeholder: "name this job…",
          caption: "⏎ rename · esc cancel",
          onCaret: composer.setCursor,
        }
      : undefined,
    error,
    begin,
    handleKey,
  };
}
