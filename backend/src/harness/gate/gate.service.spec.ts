import { RunnableLambda } from '@langchain/core/runnables';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { EmployeeRegistry } from '../employees/employee.registry';
import { TEAM_RULES } from '../employees/persona.service';
import { GateService } from './gate.service';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';

/**
 * The gate's channel-aware HARD rules. The soft (LLM) path is faked to explode — these decisions
 * must be made without a model call.
 */

const ALEX = {
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
  roleContext: 'x',
  engine: EWorkerEngineName.CLAUDE,
};

function buildGate() {
  // Text-sensitive doubles: '@alex' mentions Alex; '@here' is a broadcast.
  const employees = {
    mentionedBots: (text: string) =>
      text.includes('@alex') ? [{ id: 'alex' }] : [],
    addressedBots: (text: string) =>
      text.includes('@alex') ? [{ id: 'alex' }] : [],
    isBroadcast: (text: string) => text.includes('@here'),
    rosterSummary: () => 'Alex (backend engineer)',
  } as unknown as EmployeeRegistry;
  const models = {
    buildGateModel: () => {
      throw new Error('soft gate must not run for hard-rule decisions');
    },
  } as unknown as ChatModelFactory;
  return new GateService(employees, models);
}

describe('GateService hard rules — channel context', () => {
  it('always responds in a 1:1 DM without a model call', async () => {
    const gate = buildGate();
    const d = await gate.gate(ALEX, 'hey, quick question about the deploy', {
      authorName: 'Dennis',
      channel: { kind: 'dm', name: 'dennis ↔ alex' },
    });
    expect(d.action).toBe('respond');
  });

  it('still ignores its own message in a DM', async () => {
    const gate = buildGate();
    const d = await gate.gate(ALEX, 'my own reply', {
      authorBotId: 'alex',
      channel: { kind: 'dm', name: 'dennis ↔ alex' },
    });
    expect(d.action).toBe('ignore');
  });
});

describe('GateService soft gate — prompt enrichment', () => {
  it('includes protocols and team rules when invoking the soft model', async () => {
    const captured: string[] = [];
    const employees = {
      mentionedBots: () => [],
      addressedBots: () => [],
      isBroadcast: () => false,
      rosterSummary: () => 'Alex (backend engineer)',
    } as unknown as EmployeeRegistry;
    const models = {
      buildGateModel: () => ({
        withStructuredOutput: () =>
          RunnableLambda.from((promptValue: { toString(): string }) => {
            captured.push(promptValue.toString());
            return {
              raw: { usage_metadata: null },
              parsed: { action: 'respond', reasoning: 'mocked' },
            };
          }),
      }),
    } as unknown as ChatModelFactory;
    const gate = new GateService(employees, models);

    await gate.gate(
      { ...ALEX, protocols: ['Work only in your lane', 'Always write tests'] },
      'what do you think about this approach?',
      { authorName: 'Dennis', channel: { kind: 'channel', name: 'dev' } },
    );

    expect(captured).toHaveLength(1);
    const prompt = captured[0];
    expect(prompt).toContain('Work only in your lane');
    expect(prompt).toContain('Always write tests');
    expect(prompt).toContain(TEAM_RULES.slice(0, 60)); // first 60 chars confirm it's inlined
  });

  it('soft gate still works when the employee has no protocols', async () => {
    const employees = {
      mentionedBots: () => [],
      addressedBots: () => [],
      isBroadcast: () => false,
      rosterSummary: () => 'Alex (backend engineer)',
    } as unknown as EmployeeRegistry;
    const models = {
      buildGateModel: () => ({
        withStructuredOutput: () =>
          RunnableLambda.from(() => ({
            raw: { usage_metadata: null },
            parsed: { action: 'ignore', reasoning: 'mocked' },
          })),
      }),
    } as unknown as ChatModelFactory;
    const gate = new GateService(employees, models);

    const d = await gate.gate(ALEX, 'hey', {
      authorName: 'Dennis',
      channel: { kind: 'channel', name: 'dev' },
    });
    expect(d.action).toBe('ignore');
  });
});

describe('GateService hard rules — batch scanning', () => {
  // A busy bot consumes several messages in one turn; a hail must not be swallowed because a
  // teammate's reply landed after it (the live bug: only one bot answered an @here).
  it('responds to a broadcast buried in the batch behind a teammate reply', async () => {
    const gate = buildGate();
    const d = await gate.gate(
      ALEX,
      'Morning Dennis! Memory looks clean on my end.',
      {
        authorBotId: 'riley',
        batch: [
          { text: 'Hey guys, how is everybody doing?' },
          { text: '@here' },
          {
            text: 'Morning Dennis! Memory looks clean on my end.',
            authorBotId: 'riley',
          },
        ],
      },
    );
    expect(d.action).toBe('respond');
  });

  it('responds to an @mention buried in the batch', async () => {
    const gate = buildGate();
    const d = await gate.gate(ALEX, 'unrelated chatter', {
      batch: [
        { text: '@alex can you check the deploy?' },
        { text: 'unrelated chatter' },
      ],
    });
    expect(d.action).toBe('respond');
  });

  it('does NOT hard-respond to its OWN broadcast in the batch', async () => {
    const gate = buildGate();
    // The only @here in the batch is Alex's own message — hard rules must not self-trigger; the
    // soft gate would run next (faked to throw → falls back to ignore).
    const d = await gate.gate(ALEX, 'someone else talking', {
      batch: [
        { text: 'team, @here, standup in 5', authorBotId: 'alex' },
        { text: 'someone else talking' },
      ],
    });
    expect(d.action).toBe('ignore');
  });
});
