import type { EnvService } from '@core/config/env/env.service';
import { describe, expect, it } from 'vitest';
import type { EmployeeDefinition } from '../employees/employee.types';
import type { EmployeeRegistry } from '../employees/employee.registry';
import type { CredentialContext } from '../llm-keys/credential-context';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { AddressingGate } from './addressing-gate';

/**
 * Acceptance test (real Haiku) for the AddressingGate's SOFT classifier — the un-addressed middle
 * that the hard rules (DM / broadcast / @mention) never reach. It exists to lock in the prompt
 * loosening that followed a real miss: Dennis posted "…that check pipeline should now work" (a
 * status update about work Atlas was running, NOT an @mention), the old prompt read it as an aside,
 * and Atlas stayed quiet (persistent 👀) when a re-check was wanted.
 *
 * The contract this guards: a status update / observation about the assistant's OWN work
 * (builds, checks, pipelines, migrations, deploys) is an implicit cue to act → RESPOND; genuine
 * human-to-human chatter unrelated to that work → SKIP. The unit spec mocks the model and so can't
 * catch a prompt regression; this can. Runs only under `pnpm test:ai`.
 */
const hasKey = !!process.env.ANTHROPIC_API_KEY;

const atlas = { id: 'atlas', name: 'Atlas' } as EmployeeDefinition;

/** A gate wired to the REAL Haiku model, with the hard rules stubbed off so every case reaches the
 * classifier (the un-addressed path is the whole point of this test). */
function realGate(): AddressingGate {
  const env = { get: () => undefined } as unknown as EnvService;
  const creds = {
    anthropicKey: () => process.env.ANTHROPIC_API_KEY,
  } as unknown as CredentialContext;
  const models = new ChatModelFactory(env, creds);
  const employees = {
    isBroadcast: () => false,
    addressedBots: () => [] as EmployeeDefinition[],
  } as unknown as EmployeeRegistry;
  return new AddressingGate(employees, models);
}

describe.skipIf(!hasKey)('AddressingGate soft classifier (real Haiku)', () => {
  // Un-addressed status updates about Atlas's own work — must RESPOND (the regression cases).
  const respondCases: { text: string; history: string }[] = [
    {
      // The exact miss that motivated the change.
      text: 'I forgot to do a database migration. That check pipeline should now work',
      history:
        'Dennis: How is the build going @atlas\nAtlas: Hit a harness error on that check — retrying once.\nAtlas: check_pipeline is throwing a DB schema error — harness bug, not the pipeline itself.',
    },
    {
      text: 'ok the env var is fixed, try the deploy again',
      history:
        'Atlas: Deploy failed — STRIPE_KEY is missing from the prod env.\nDennis: looking',
    },
    {
      text: 'CI is green now',
      history:
        'Atlas: Opened the PR — waiting on CI before I mark it ready.\nDennis: one of the checks was flaky, re-running it',
    },
    {
      text: 'the migration ran, schema should be current',
      history:
        'Atlas: The fixup session is blocked — the column it needs does not exist yet.\nDennis: my bad, running the migration',
    },
  ];

  // Genuine human-to-human chatter unrelated to Atlas's work — must SKIP (guards over-loosening).
  const skipCases: { text: string; history: string }[] = [
    {
      text: 'haha nice one',
      history: 'Dennis: did you see the standup blooper\nPat: lol yeah',
    },
    {
      text: 'thanks!',
      history:
        'Pat: I dropped the design files in the drive for you\nDennis: perfect',
    },
    {
      text: 'anyone grabbing lunch?',
      history: 'Pat: morning all\nDennis: morning',
    },
    {
      text: "I'll be out tomorrow afternoon, dentist",
      history: 'Pat: how is everyone doing on the sprint\nDennis: on track',
    },
  ];

  it.each(respondCases)(
    'RESPONDS to a work status update: "$text"',
    async ({ text, history }) => {
      const verdict = await realGate().decide({
        bot: atlas,
        isDm: false,
        text,
        history,
      });
      console.log(`[gate-ai] respond? "${text}" → ${verdict}`);
      expect(verdict).toBe('respond');
    },
  );

  it.each(skipCases)(
    'SKIPS unrelated human-to-human chatter: "$text"',
    async ({ text, history }) => {
      const verdict = await realGate().decide({
        bot: atlas,
        isDm: false,
        text,
        history,
      });
      console.log(`[gate-ai] skip? "${text}" → ${verdict}`);
      expect(verdict).toBe('skip');
    },
  );
});
