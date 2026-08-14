import type { AttachmentPart } from "../domain/attachments.js";
import type { DraftImage } from "../domain/draft-images.js";
import type { EHarnessVariant } from "../domain/message.js";
import type { EngineTool } from "../engine/atlas-tool-server.js";
import type { EngineSession, Thread } from "../generated/prisma/client.js";

/**
 * Everything it takes to run one turn.
 *
 * It lives beside the runner rather than inside it because half the file's importers want only this:
 * a rotation composing the successor's first turn, a seam composing a thread's first, a test
 * asserting what was fired. `turn-runner.service.ts` re-exports it, so nothing has to know it moved.
 */
export type RunTurnArgs = {
  thread: Thread;
  session: EngineSession;
  prompt: string;
  cwd: string;
  /**
   * Set when ATLAS is speaking rather than Dennis: the same prompt, persisted as a `harness` message
   * and delivered inside an envelope. Absent means the human typed it, and it goes in bare.
   */
  harnessVariant?: EHarnessVariant;
  /**
   * The files a SEAM inlined into this prompt, as rows. Stored on the message beside the prose and
   * composed into the wire string by `renderPrompt`, so the transcript can draw a collapsed chip per
   * file and the model still receives every byte. Only a seam sets it; an ordinary turn has none.
   */
  attachments?: readonly AttachmentPart[];
  /**
   * Pictures pasted into the draft this prompt came from, as paths. Read off disk on the way to the
   * engine and stored on the message as-is, so reopening the thread a week later still finds them.
   *
   * Nothing like `attachments` above, which is a seam's inlined FILES: these are images a person
   * pasted, and the two share only the fact that a message can carry something besides prose.
   */
  images?: readonly DraftImage[];
  /**
   * The phase's standing instructions, appended to the envelope vocabulary on this turn's system
   * prompt. Passed in rather than looked up: the runner deals in threads and sessions, and a phase
   * read on the hot path would be a database round trip per turn for a string that cannot change.
   */
  brief?: string;
  /**
   * Atlas's tools for this thread, already gated, passed in for the same reason as `brief` — and
   * for one more: the runner must not learn what a tool is. Resolving them here would mean injecting
   * the service that OWNS them, which is also the service that fires the successor's first turn.
   */
  tools?: readonly EngineTool[];
};
