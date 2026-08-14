import { z } from 'zod';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

/**
 * The one cost of adding a tool rather than replacing `Bash`: the model has to choose between two
 * ways of backgrounding a command. So the choice is stated here, in the only place it can be read at
 * the moment it is made — and unlike refusing the call at run time, saying it costs nothing when the
 * model gets it right.
 */
const DESCRIPTION = `Start a long-lived process this JOB owns.

Short, finite work stays on \`Bash(run_in_background)\` — the turn is held open until it lands, so it
reports back to you in this turn. Anything that should still be running after this turn ends — dev
servers, watchers, long-lived services — goes here.

It survives turns, sessions and thread seams, and dies when Atlas does. There is no completion
signal and nothing will notify you: stdout and stderr both go to a log file, and you read it with
\`Read\` or \`Bash\` when you want to know. \`service_list\` shows what is running, \`service_stop\`
ends one.`;

const COMMAND = `The command, exactly as a shell would run it.

Started once, from \`cwd\`, with no terminal attached — nothing here reads stdin, and a command that
waits for input will simply hang.`;

const CWD = `Where to run it. Defaults to the job's working directory, which is almost always right.`;

const SERVICE_DESCRIPTION = `What this service is, in a few words — "web dev server", "prisma studio".

It is how you and Dennis both recognise it later, in \`service_list\` and in Atlas's own services
page, so name the job it does rather than repeating the command.`;

export function serviceStartTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const { services } = args.actions;
  if (!services) return null;

  const shape = {
    command: z.string().min(1).describe(COMMAND),
    description: z.string().min(1).describe(SERVICE_DESCRIPTION),
    cwd: z.string().min(1).optional().describe(CWD),
  };

  return {
    name: EAtlasTool.service_start,
    // Threads only, like every other Atlas tool that changes something. A teammate is a subagent of
    // one turn; a process that outlives the job's turns is not its to start.
    tiers: [EToolTier.thread],
    description: DESCRIPTION,
    shape,
    handler: async (raw) => {
      const parsed = z.object(shape).safeParse(raw);
      // A throw, not a sentence — unlike a malformed checklist call, a start that did not happen must
      // be unmissable, and `atlasToolServer` turns this into an `isError` result the agent can retry
      // against rather than an exception that takes the turn down.
      if (!parsed.success) {
        throw new Error(
          'service_start takes `command` and `description`, both non-empty strings, and an optional `cwd`. Nothing was started.',
        );
      }
      return services.start({
        jobId: args.ctx.job.id,
        command: parsed.data.command,
        description: parsed.data.description,
        cwd: parsed.data.cwd ?? args.ctx.cwd,
      });
    },
  };
}
