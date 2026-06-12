/**
 * Circular-import smoke test for the harness module graph.
 *
 * An ES-module cycle between Nest module files (e.g. employees → tools → engines → memory →
 * employees) surfaces as `undefined` inside a module's `imports` metadata — Nest only reports it
 * at app scan time ("The module at index [N] ... is undefined"), which unit suites never reach.
 * This spec walks the metadata the way Nest's scanner does, so the cycle fails `pnpm test`
 * instead of the next `slack:dev`/`tui:dev` boot.
 *
 * EmployeesModule is imported FIRST on purpose: roster files import tool classes for their
 * allowlists, which is the chain that closed the original cycle (caught 2026-06-12, introduced by
 * giving Sam an explicit tools field). Keep that import order — it mimics the failing load order.
 */
import { EmployeesModule } from './employees/employees.module';
import { HarnessModule } from './harness.module';

function undefinedImports(
  mod: unknown,
  seen = new Set<unknown>(),
  path: string[] = [],
): string[] {
  if (!mod || seen.has(mod)) return [];
  seen.add(mod);
  const asDynamic = mod as { name?: string; module?: { name: string }; imports?: unknown[] };
  const name = asDynamic.module?.name ?? asDynamic.name ?? String(mod);
  const target = asDynamic.module ?? mod; // DynamicModule vs plain class
  const imports: unknown[] = [
    ...((Reflect.getMetadata('imports', target) as unknown[] | undefined) ?? []),
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

describe('harness module graph (circular-import smoke)', () => {
  it('EmployeesModule subtree has no undefined imports', () => {
    expect(undefinedImports(EmployeesModule)).toEqual([]);
  });

  it('HarnessModule subtree has no undefined imports', () => {
    expect(undefinedImports(HarnessModule)).toEqual([]);
  });
});
