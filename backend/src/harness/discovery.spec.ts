import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { AIEmployee } from './employees/ai-employee.decorator';
import { PhaseConfig } from './employees/phase-config.decorator';
import { BaseEmployee } from './employees/base-employee';
import type { EmployeeContext } from './employees/employee-context';
import { EmployeeRegistry } from './employees/employee.registry';
import { HarnessTool } from './tools/harness-tool.decorator';
import { ToolRegistry } from './tools/tool.registry';
import type { HarnessToolContext, IHarnessTool } from './tools/tool.types';
import { EXECUTE_CODEX, PLAN_CODEX } from './engines/engine-presets';

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
class PingTool implements IHarnessTool<typeof echoSchema> {
  readonly name = 'ping';
  readonly description = 'A second tool.';
  readonly schema = echoSchema;
  async execute(): Promise<string> {
    return 'pong';
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
class TestAlex extends BaseEmployee {
  readonly id = 'alex';
  readonly name = 'Alex';
  readonly role = 'backend engineer';
  readonly sortOrder = 10;
  readonly teamLead = true;
  readonly tools = [EchoTool, PingTool];
  roleContext(_ctx: EmployeeContext): string {
    return 'static role context';
  }
}

@AIEmployee()
class TestSam extends BaseEmployee {
  readonly id = 'sam';
  readonly name = 'Sam';
  readonly role = 'team lead';
  readonly sortOrder = 20;
  protected readonly planPreset = PLAN_CODEX;
  protected readonly executePreset = EXECUTE_CODEX;
  roleContext(_ctx: EmployeeContext): string {
    return 'static role context';
  }
}

// A synthetic worker identity (pipeline phase-config) — discovered into a SEPARATE list from the
// chat roster: resolvable + provisioned, but never a channel participant.
@PhaseConfig()
class TestPhaseBackend extends BaseEmployee {
  readonly id = 'phase_backend';
  readonly name = 'Backend';
  readonly role = 'backend engineer';
  readonly sortOrder = 1000;
  roleContext(_ctx: EmployeeContext): string {
    return 'static backend phase context';
  }
}

async function buildModule(
  extraProviders: any[] = [TestAlex, TestSam, EchoTool, PingTool],
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
    expect(registry.byId('sam')?.planEngine(registry.context()).engine).toBe(
      'codex',
    );
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
    const bound = tools.toStructuredTools([EchoTool, PingTool]);
    expect(bound.map((t) => t.name)).toEqual(['echo', 'ping']);

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
    class DupAlex extends BaseEmployee {
      readonly id = 'alex';
      readonly name = 'Alex2';
      readonly role = 'impostor';
      readonly sortOrder = 30;
      roleContext(_ctx: EmployeeContext): string {
        return 'x';
      }
    }
    await expect(
      buildModule([TestAlex, TestSam, DupAlex, EchoTool, PingTool]),
    ).rejects.toThrow(/Duplicate employee id 'alex'/);
  });

  it('fails boot unless exactly one employee is team lead', async () => {
    await expect(buildModule([TestSam, EchoTool, PingTool])).rejects.toThrow(
      /Exactly one employee/,
    );
  });

  it('resolves + provisions phase-configs but keeps them OFF the chat roster', async () => {
    const moduleRef = await buildModule([
      TestAlex,
      TestSam,
      TestPhaseBackend,
      EchoTool,
      PingTool,
    ]);
    const registry = moduleRef.get(EmployeeRegistry);

    // Resolvable by id and included in the provisioning set (gets a scoped per-engine home)…
    expect(registry.byId('phase_backend')?.id).toBe('phase_backend');
    expect(registry.provisionable().map((e) => e.id)).toContain('phase_backend');

    // …but NEVER on the live chat roster, summary, or addressing — no phantom channel participant.
    expect(registry.list().map((e) => e.id)).toEqual(['alex', 'sam']);
    expect(registry.rosterSummary()).not.toContain('Backend');
    expect(
      registry.addressedBots('Backend, build the API').map((e) => e.id),
    ).toEqual([]);
    expect(registry.mentionedBots('@phase_backend').map((e) => e.id)).toEqual(
      [],
    );

    // The prompt `${roster}` is the PIPELINE phase roles (what specialists Atlas dispatches), NOT the
    // chat roster — so the phase-config DOES feed `context().roster`, even though it's off the chat
    // roster. Guards the bug where deleting the named specialists would collapse `${roster}` to Atlas.
    expect(registry.context().roster).toContain('Backend');
  });

  it('fails boot when a phase-config id collides with a roster employee id', async () => {
    @PhaseConfig()
    class CollidingPhase extends BaseEmployee {
      readonly id = 'alex';
      readonly name = 'Backend';
      readonly role = 'backend engineer';
      readonly sortOrder = 1000;
      roleContext(_ctx: EmployeeContext): string {
        return 'x';
      }
    }
    await expect(
      buildModule([TestAlex, TestSam, CollidingPhase, EchoTool, PingTool]),
    ).rejects.toThrow(/collides/);
  });
});
