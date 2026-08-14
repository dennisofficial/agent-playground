import { ESlashCommand, parseSlashCommand } from '../domain/commands.js';
import { EHarnessVariant } from '../domain/message.js';
import { rotationRequest } from '../domain/rotation-handoff.js';

/**
 * What a command needs of the conversation, and no more — so this can be driven by a test without a
 * container, a renderer or a database behind it.
 */
export type CommandTarget = {
  sendHarness(args: { variant: EHarnessVariant; text: string }): Promise<void>;
};

/**
 * Run a slash command, or report that this draft was not one.
 *
 * The palette used to only FILL the composer, so pressing Enter sent `/rotate` to the model as
 * ordinary text — a suggestion it could answer in prose, ignore, or take as a topic of conversation.
 * A command is a host act. It happens here and the model never sees the word.
 *
 * `false` means "this is prose, send it" rather than "unknown command": a slash word Atlas does not
 * run yet still reaches the agent, which is what it did before and is better than a palette that
 * recognises a command and silently swallows it.
 */
export async function runSlashCommand(args: {
  text: string;
  conversation: CommandTarget;
  /** Push the services page. A host act with no message in it — see `ESlashCommand.services`. */
  onServices: () => void;
}): Promise<boolean> {
  const command = parseSlashCommand(args.text);

  if (command === ESlashCommand.services) {
    args.onServices();
    return true;
  }

  if (command !== ESlashCommand.rotate) return false;

  // A request, not a cut — and the SAME request the context nudge sends, so the manual and the
  // nudged paths are one path and every rotation is the agent's own tool call. Atlas cutting a
  // session itself would hand the successor a hand-off nobody wrote.
  await args.conversation.sendHarness({
    variant: EHarnessVariant.transition,
    text: rotationRequest(),
  });
  return true;
}
