import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { AIEmployee } from './employees/ai-employee.decorator';
import { EmployeeRegistry } from './employees/employee.registry';
import type { EmployeeDefinition } from './employees/employee.types';
import { HarnessTool } from './tools/harness-tool.decorator';
import { ToolRegistry } from './tools/tool.registry';
import type { HarnessToolContext, IHarnessTool } from './tools/tool.types';

const echoSchema = z.object({ text: z.string() });

@HarnessTool()
class EchoTool implements IHarnessTool<typeof echoSchema> {
  readonly name = 'echo';
  readonly description = 'Echoes the input back.';
  readonly schema = echoSchema;
  async execute(
    args: z.infer<typeof echoSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    return `${ctx.identity.selfAgent}: ${args.text}`;
  }
}

@HarnessTool()
class EndTurnTool implements IHarnessTool<typeof echoSchema> {
  readonly name = 'end_turn';
  readonly description = 'Ends the turn.';
  readonly schema = echoSchema;
  readonly terminal = true;
  async execute(): Promise<string> {
    return 'done';
  }
}

// Decorated but deliberately NOT registered as a provider — allowlisting it must throw.
@HarnessTool()
class UnregisteredTool implements IHarnessTool<typeof echoSchema> {
  readonly name = 'unregistered';
  readonly description = 'Never registered.';
  readonly schema = echoSchema;
  async execute(): Promise<string> {
    return '';
  }
}

@AIEmployee()
class TestAlex implements EmployeeDefinition {
  readonly id = 'alex';
  readonly name = 'Alex';
  readonly role = 'backend engineer';
  readonly sortOrder = 10;
  readonly roleContext = 'static role context';
  readonly engine = 'claude' as const;
  readonly teamLead = true;
  readonly tools = [EchoTool, EndTurnTool];
}

@AIEmployee()
class TestSam implements EmployeeDefinition {
  readonly id = 'sam';
  readonly name = 'Sam';
  readonly role = 'team lead';
  readonly sortOrder = 20;
  readonly roleContext = 'static role context';
  readonly engine = 'codex' as const;
}

async function buildModule(
  extraProviders: any[] = [TestAlex, TestSam, EchoTool, EndTurnTool],
) {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [EmployeeRegistry, ToolRegistry, ...extraProviders],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('harness decorator discovery', () => {
  it('discovers @AIEmployee classes into a sorted, validated roster', async () => {
    const moduleRef = await buildModule();
    const registry = moduleRef.get(EmployeeRegistry);
    expect(registry.list().map((e) => e.id)).toEqual(['alex', 'sam']);
    expect(registry.byId('sam')?.engine).toBe('codex');
    expect(registry.fallbackOwner().id).toBe('alex');
    expect(
      registry.addressedBots('Alex, can you take a look?').map((e) => e.id),
    ).toEqual(['alex']);
    expect(registry.isBroadcast('@here standup time')).toBe(true);
    expect(registry.rosterSummary()).toBe(
      'Alex — backend engineer; Sam — team lead',
    );
  });

  it('resolves a class-reference allowlist into bound LangChain tools', async () => {
    const moduleRef = await buildModule();
    const tools = moduleRef.get(ToolRegistry);
    const bound = tools.toStructuredTools([EchoTool, EndTurnTool]);
    expect(bound.map((t) => t.name)).toEqual(['echo', 'end_turn']);
    expect(tools.terminalToolNames([EchoTool, EndTurnTool])).toEqual(
      new Set(['end_turn']),
    );

    const result = await (bound[0] as any).invoke(
      { text: 'hi' },
      { configurable: { identity: { selfAgent: 'alex' } } },
    );
    expect(result).toBe('alex: hi');
  });

  it('throws loudly when an allowlist references an unregistered tool class', async () => {
    const moduleRef = await buildModule();
    const tools = moduleRef.get(ToolRegistry);
    expect(() => tools.toStructuredTools([UnregisteredTool])).toThrow(
      /UnregisteredTool is not registered/,
    );
  });

  it('fails boot on duplicate employee ids', async () => {
    @AIEmployee()
    class DupAlex implements EmployeeDefinition {
      readonly id = 'alex';
      readonly name = 'Alex2';
      readonly role = 'impostor';
      readonly sortOrder = 30;
      readonly roleContext = 'x';
      readonly engine = 'claude' as const;
    }
    await expect(
      buildModule([TestAlex, TestSam, DupAlex, EchoTool, EndTurnTool]),
    ).rejects.toThrow(/Duplicate employee id 'alex'/);
  });

  it('fails boot unless exactly one employee is team lead', async () => {
    await expect(buildModule([TestSam, EchoTool, EndTurnTool])).rejects.toThrow(
      /Exactly one employee/,
    );
  });
});
