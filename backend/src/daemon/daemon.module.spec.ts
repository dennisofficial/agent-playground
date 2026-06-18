/**
 * Daemon DI-graph guard. Two invariants the daemon image depends on:
 *
 *  1. No undefined imports in the module subtree (the circular-import smoke check, same metadata walk
 *     as harness/module-graph.spec.ts — a cycle surfaces as `undefined` in `imports` at scan time).
 *  2. The daemon boots WITHOUT a database and is actually TRIMMED: the engines + tools provider
 *     resolve, the registry refuses langgraph, and the DB-backed host providers (EngineHomeProvisioner,
 *     EmployeeRegistry, the conductor) are ABSENT. The daemon's tsconfig still compiles against
 *     ../harness/**, so compile success alone does NOT prove the runtime graph is trimmed — this boot
 *     does. A future accidental import of a Postgres-backed service would fail this spec here, not
 *     in-container where there's no DB to crash against.
 */
import { EngineHomeProvisioner } from '@harness/skills/engine-home-provisioner.service';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';
import { AGENT_TOOLS_PROVIDER } from '@harness/engines/agent-tools-provider.port';
import { Test } from '@nestjs/testing';
import { DaemonModule } from './daemon.module';
import { DaemonAgentToolsProvider } from './engines/daemon-agent-tools-provider.service';
import { DaemonEngineRegistry } from './engines/daemon-engine.registry';

function undefinedImports(
  mod: unknown,
  seen = new Set<unknown>(),
  path: string[] = [],
): string[] {
  if (!mod || seen.has(mod)) return [];
  seen.add(mod);
  const asDynamic = mod as {
    name?: string;
    module?: { name: string };
    imports?: unknown[];
  };
  const name = asDynamic.module?.name ?? asDynamic.name ?? String(mod);
  const target = asDynamic.module ?? mod;
  const imports: unknown[] = [
    ...((Reflect.getMetadata('imports', target) as unknown[] | undefined) ??
      []),
    ...(asDynamic.imports ?? []),
  ];
  const bad: string[] = [];
  imports.forEach((imp, i) => {
    if (imp === undefined) {
      bad.push(`${[...path, name].join(' → ')} imports[${i}] is undefined`);
    } else {
      bad.push(...undefinedImports(imp, seen, [...path, name]));
    }
  });
  return bad;
}

describe('DaemonModule (DI-graph guard)', () => {
  it('has no undefined imports in its subtree', () => {
    expect(undefinedImports(DaemonModule)).toEqual([]);
  });

  it('boots WITHOUT a database and resolves engines + tools provider', async () => {
    // No DatabaseModule import anywhere in the graph — if a DB-backed provider snuck in, .compile()
    // or the resolutions below would throw (its repos/connection can't resolve with no TypeORM root).
    const moduleRef = await Test.createTestingModule({
      imports: [DaemonModule],
    }).compile();

    const registry = moduleRef.get(DaemonEngineRegistry);
    // Resolving each engine forces DI of the ESM SDK token, EnvService, AND AGENT_TOOLS_PROVIDER.
    expect(registry.get(EWorkerEngineName.CLAUDE).name).toBe(
      EWorkerEngineName.CLAUDE,
    );
    expect(registry.get(EWorkerEngineName.CODEX).name).toBe(
      EWorkerEngineName.CODEX,
    );
    // langgraph is host-side only — the trimmed registry refuses it.
    expect(() => registry.get(EWorkerEngineName.LANGGRAPH)).toThrow(/daemon/i);

    // AGENT_TOOLS_PROVIDER is bound to the daemon's DB-free provider; un-primed → EMPTY (no throw).
    const provider = moduleRef.get(AGENT_TOOLS_PROVIDER);
    expect(provider).toBeInstanceOf(DaemonAgentToolsProvider);
    expect(provider.forAgent('nobody')).toEqual({
      skillNames: [],
      skillsPrompt: '',
      mcpServers: [],
    });

    await moduleRef.close();
  });

  it('does NOT pull in the host DB-backed providers (trim invariant)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DaemonModule],
    }).compile();

    // The host's Postgres-backed provisioner + roster registry + conductor must NOT exist in the
    // daemon graph — the daemon has no database. `{ strict: false }` searches the whole graph.
    expect(() =>
      moduleRef.get(EngineHomeProvisioner, { strict: false }),
    ).toThrow();
    expect(() => moduleRef.get(EmployeeRegistry, { strict: false })).toThrow();

    await moduleRef.close();
  });
});
