import { z } from 'zod';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Stop a service this job started, and everything it spawned.

The whole process group goes, not just the command you named — a dev server is a tree, and killing
the shell alone leaves the rest of it holding the port. The log file stays where it is.

Stopping something already gone is a sentence back, not a failure.`;

const ID = `The service id, as \`service_start\` returned it or \`service_list\` shows it.`;

export function serviceStopTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const { services } = args.actions;
  if (!services) return null;

  const shape = { id: z.string().min(1).describe(ID) };

  return {
    name: EAtlasTool.service_stop,
    tiers: [EToolTier.thread],
    description: DESCRIPTION,
    shape,
    handler: async (raw) => {
      const parsed = z.object(shape).safeParse(raw);
      // A sentence rather than a throw, and the asymmetry with `service_start` is deliberate: a stop
      // that did not happen leaves the world as it was, and every other way this call can miss — an
      // unknown id, a service that already exited — is answered in prose too.
      if (!parsed.success) {
        return 'service_stop takes `id`, the service id from `service_start` or `service_list`. Nothing was stopped.';
      }
      return services.stop({ jobId: args.ctx.job.id, id: parsed.data.id });
    },
  };
}
