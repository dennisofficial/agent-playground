import { Inject, Optional } from '@nestjs/common';
import { z } from 'zod';
import { EmployeeRegistry } from '../../employees/employee.registry';
import {
  ROTATE_KEYS_PRESENTER,
  type RotateKeysPresenter,
} from '../../llm-keys/rotate-keys-presenter.port';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const rotateKeysSchema = z.object({
  reason: z
    .string()
    .describe(
      'Why the keys need updating, in your own words — rendered on the card so Dennis knows what to fix (e.g. "Codex returned 401 — the subscription token looks expired", or "Dennis asked to rotate the keys").',
    ),
  suspected: z
    .array(z.string())
    .optional()
    .describe(
      'Which credentials look expired, to highlight on the card (e.g. ["Codex subscription", "OpenAI API key"]). Omit if unsure — the modal always offers every field.',
    ),
});

/**
 * Pop the "update your keys" modal for Dennis — the secrets path (a key/token must NEVER cross chat).
 * The tool itself takes NO secret; it posts a Slack card with a button, and the button opens the modal
 * where Dennis pastes the new value(s), which go straight to the encrypted store. Lead-only.
 *
 * Use it BOTH ways: when Dennis asks ("rotate my keys"), and PROACTIVELY the moment you see an
 * unauthorized/expired-credential error — name the suspect in `reason` so he knows what to fix. After
 * he submits, you're woken to retry whatever was blocked. (Headless/no-Slack → degrades to asking in chat.)
 */
@HarnessTool()
export class RotateKeysTool implements IHarnessTool<typeof rotateKeysSchema> {
  readonly name = 'rotate_keys';
  readonly description =
    "Ask Dennis to update this workspace's LLM credentials — pops a secure Slack modal where he pastes the new Anthropic/OpenAI API key or a re-issued Claude/Codex subscription token (secrets NEVER go through chat, so don't ask for them in a message). Call it when he asks to rotate keys, OR proactively the instant you hit an unauthorized/401/expired-credential error — put the suspect in `reason`. After he submits you're woken to retry. Lead-only.";
  readonly schema = rotateKeysSchema;

  constructor(
    private readonly employees: EmployeeRegistry,
    @Optional()
    @Inject(ROTATE_KEYS_PRESENTER)
    private readonly presenter?: RotateKeysPresenter,
  ) {}

  async execute(
    { reason, suspected }: z.infer<typeof rotateKeysSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    if (!this.employees.byId(id.selfAgent)?.teamLead)
      return `Updating credentials is the team lead's call.`;

    if (!this.presenter)
      return `No Slack surface here to post an update-keys card. Ask Dennis to update the workspace's keys (Anthropic/OpenAI API key, or the Claude/Codex subscription token) via the admin API or his Slack workspace — never have him paste a key in chat.`;

    try {
      await this.presenter.present({
        team: id.team,
        surfaceId: id.surface,
        reason,
        suspected,
      });
    } catch (err) {
      return `Couldn't post the update-keys card (${err instanceof Error ? err.message : String(err)}). Tell Dennis to update the keys via the admin API — never in chat.`;
    }

    return `Posted an update-keys card in the channel for Dennis. He pastes the new credential(s) in a secure modal; once he submits, you'll be woken to retry whatever was blocked. Don't re-run rotate_keys meanwhile, and never ask for the secret in chat.`;
  }
}
