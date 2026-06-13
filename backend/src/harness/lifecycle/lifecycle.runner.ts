import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  isLifecycleCapability,
  type LifecycleCapability,
} from '../employees/capability';
import type { EmployeeContext } from '../employees/employee-context';
import { LIFECYCLE_HANDLERS, type LifecycleHandler } from './lifecycle.handler';
import {
  TRANSFORM_CONTRACT,
  type LifecycleEvent,
  type LifecyclePayloads,
} from './lifecycle.types';

/** What the runner needs to build the injected `EmployeeContext` (PersonaService implements it). */
export interface EmployeeContextProvider {
  context(): EmployeeContext;
}

/** DI token for the context provider so the runner stays decoupled from PersonaService internals. */
export const EMPLOYEE_CONTEXT_PROVIDER = Symbol('EMPLOYEE_CONTEXT_PROVIDER');

/**
 * Engine-agnostic, in-process lifecycle-hook runner — the middleware seam between the harness and a
 * teammate's declared capabilities. It knows nothing about self-review specifically: it gathers the
 * hooks an employee declares for an event (the membership gate), filters by each hook's typed
 * matcher, orders them, and runs them — blocking hooks as an awaited transform chain (each may
 * replace only the contract-allowed payload fields), async hooks fire-and-forget. Blocking hooks are
 * error-isolated (a throw or timeout falls back to the prior payload — best-effort, never breaks the
 * turn) and abort-aware.
 */
@Injectable()
export class LifecycleRunner {
  private readonly logger = new Logger(LifecycleRunner.name);
  private readonly handlers = new Map<string, LifecycleHandler>();

  constructor(
    @Inject(EMPLOYEE_CONTEXT_PROVIDER)
    private readonly contextProvider: EmployeeContextProvider,
    @Inject(LIFECYCLE_HANDLERS) handlers: LifecycleHandler[],
  ) {
    for (const h of handlers) {
      if (this.handlers.has(h.capability))
        throw new Error(
          `Duplicate LifecycleHandler for capability '${h.capability}'`,
        );
      this.handlers.set(h.capability, h);
    }
  }

  /**
   * Run every hook the owning employee declares for `event`, in order, through `payload`. Returns the
   * (possibly transformed) final payload. Blocking hooks form a middleware chain; an unhandled or
   * un-registered capability is skipped (boot-validation rejects misconfiguration before this point).
   */
  async run<E extends LifecycleEvent>(
    event: E,
    payload: LifecyclePayloads[E],
  ): Promise<LifecyclePayloads[E]> {
    const ctx = this.contextProvider.context();
    const hooks = payload.employee
      .capabilities(ctx)
      .filter(isLifecycleCapability)
      .filter((c) => c.trigger.on === event)
      .filter(
        (c) =>
          !c.matcher ||
          (c.matcher as (p: LifecyclePayloads[E]) => boolean)(payload),
      )
      .sort((a, b) => (a.trigger.order ?? 0) - (b.trigger.order ?? 0));

    if (hooks.length === 0) return payload;

    const allowed = TRANSFORM_CONTRACT[event] as ReadonlyArray<
      keyof LifecyclePayloads[E]
    >;
    let current = payload;

    for (const cap of hooks) {
      const handler = this.handlers.get(cap.name);
      if (!handler) {
        this.logger.warn(
          `No LifecycleHandler registered for capability '${cap.name}' — skipping`,
        );
        continue;
      }
      if (current.signal.aborted) break;
      const spec = cap.spec(ctx);

      if (cap.trigger.mode === 'async') {
        void this.invoke(handler, event, current, spec, cap.trigger.timeoutMs)
          .catch((err) =>
            this.logger.warn(
              `async hook '${cap.name}' failed: ${asMessage(err)}`,
            ),
          );
        continue;
      }

      // Blocking: awaited, error-isolated, contract-enforced.
      try {
        const result = await this.invoke(
          handler,
          event,
          current,
          spec,
          cap.trigger.timeoutMs,
        );
        if (result) current = applyContract(current, result, allowed);
      } catch (err) {
        this.logger.warn(
          `blocking hook '${cap.name}' failed (${asMessage(err)}) — keeping the prior payload`,
        );
      }
    }
    return current;
  }

  private invoke<E extends LifecycleEvent>(
    handler: LifecycleHandler,
    event: E,
    payload: LifecyclePayloads[E],
    spec: Parameters<LifecycleHandler['handle']>[2],
    timeoutMs?: number,
  ): Promise<unknown> {
    const run = handler.handle(event, payload, spec);
    if (!timeoutMs) return Promise.resolve(run);
    return Promise.race([
      Promise.resolve(run),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`hook timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }
}

/** Take ONLY the contract-allowed keys from a hook's returned partial. */
function applyContract<E extends LifecycleEvent>(
  current: LifecyclePayloads[E],
  result: unknown,
  allowed: ReadonlyArray<keyof LifecyclePayloads[E]>,
): LifecyclePayloads[E] {
  const patch: Partial<LifecyclePayloads[E]> = {};
  const r = result as Partial<LifecyclePayloads[E]>;
  for (const key of allowed) {
    if (key in r) patch[key] = r[key];
  }
  return { ...current, ...patch };
}

const asMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
