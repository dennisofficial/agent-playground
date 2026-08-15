import type { AttachmentPart } from "../domain/attachments.js";
import { EHarnessVariant } from "../domain/message.js";
import { successorSeed, type SeedHandoff } from "../domain/thread-handoff.js";
import type { Job, Thread } from "../generated/prisma/client.js";
import type { PhaseBriefService } from "./phase-brief.service.js";
import type { SessionManagerService } from "./session-manager.service.js";
import type { AtlasTool } from "./tools/tool.js";
import type { TurnRunnerService } from "./turn-runner.service.js";

/**
 * Atlas speaking first in a thread: the seed, a hand-off, a delegate's report back.
 *
 * Plain functions rather than methods, for the same reason `thread-delegation.ts` and
 * `turn-completion.ts` are: they hold no state, and `ThreadSeamService` is at its size limit with the
 * decisions — which seam moves what, and what a proposal is — which is the part worth reading there.
 */

/** What firing a harness turn needs from the container, and nothing else. */
export type SeedDeps = {
  phaseBriefService: PhaseBriefService;
  sessionManagerService: SessionManagerService;
  turnRunnerService: TurnRunnerService;
  toolsFor: (args: {
    job: Job;
    thread: Thread;
    cwd: string;
  }) => Promise<readonly AtlasTool[]>;
  onError: (message: string) => void;
};

export async function seedThread(
  args: SeedDeps & {
    job: Job;
    thread: Thread;
    cwd: string;
    handoff?: SeedHandoff;
  },
): Promise<void> {
  // The manifest, where the caller has one. It is what the message STORES, and `renderPrompt`
  // composes the same bytes back onto the wire — so the prose must not also carry the bodies, or
  // the successor would read every attachment twice.
  const parts = args.handoff?.parts;
  await fireHarnessTurn({
    ...args,
    ...(parts && parts.length > 0 ? { attachments: parts } : {}),
    // `handoff` where one was carried, `seed` where the thread simply began: the variant is what
    // the renderer labels and what the system prompt teaches the agent to read.
    harnessVariant: args.handoff
      ? EHarnessVariant.handoff
      : EHarnessVariant.seed,
    prompt: (opening) =>
      args.handoff
        ? successorSeed({
            opening,
            handoff: args.handoff.text,
            fromRole: args.handoff.fromRole,
            attachments: parts ? "" : args.handoff.attachments,
            ...(args.handoff.kind ? { kind: args.handoff.kind } : {}),
            ...(args.handoff.tasks ? { tasks: args.handoff.tasks } : {}),
          })
        : opening,
  });
}

/**
 * The turn is deliberately NOT awaited: `run()` resolves when the turn does, and neither creating a
 * job nor closing a thread may block behind an agent thinking. A failure lands in the thread's own
 * store as an error block, which is where the human is already looking.
 *
 * `prompt` is a function of the phase's opening words rather than a string because only this function
 * has resolved them — a caller that wanted them would have to read the brief a second time, for a
 * value that cannot differ.
 */
export async function fireHarnessTurn(
  args: SeedDeps & {
    job: Job;
    thread: Thread;
    cwd: string;
    harnessVariant: EHarnessVariant;
    prompt: (opening: string) => string;
    /** The seam's inlined files, stored as a manifest beside the prose. See `RunTurnArgs`. */
    attachments?: readonly AttachmentPart[];
  },
): Promise<void> {
  const brief = await args.phaseBriefService.forPhase({
    job: args.job,
    phaseId: args.thread.phaseId,
  });
  const session = await args.sessionManagerService.currentSession(args.thread);
  const tools = await args.toolsFor(args);

  void args.turnRunnerService
    .run({
      thread: args.thread,
      session,
      prompt: args.prompt(brief.opening),
      harnessVariant: args.harnessVariant,
      ...(args.attachments ? { attachments: args.attachments } : {}),
      brief: brief.instructions,
      cwd: args.cwd,
      tools,
    })
    .catch((error: unknown) => {
      args.onError(`harness turn failed: ${String(error)}`);
    });
}
