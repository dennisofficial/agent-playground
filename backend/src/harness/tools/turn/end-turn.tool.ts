import { z } from 'zod';
import { HarnessTool } from '../harness-tool.decorator';
import type { IHarnessTool } from '../tool.types';

const endTurnSchema = z.object({});

/**
 * Closes the turn with no further reply. A no-op that just returns a result (so the ToolNode
 * produces a valid tool message for it — Anthropic requires a result for every tool-call id); the
 * turn actually ends because the graph treats `terminal` tools as ending the turn.
 */
@HarnessTool()
export class EndTurnTool implements IHarnessTool<typeof endTurnSchema> {
  readonly name = 'end_turn';
  readonly description =
    'End your turn right now with no further reply. Use it alone when a message in the channel ' +
    "simply isn't yours to answer. (create_session / reply_session already end the turn themselves — " +
    "give a brief first-person heads-up as that message's TEXT, never a separate \"I'll let you " +
    'know when I\'m done" after.)';
  readonly schema = endTurnSchema;
  readonly terminal = true;

  async execute(): Promise<string> {
    return '(turn ended)';
  }
}
