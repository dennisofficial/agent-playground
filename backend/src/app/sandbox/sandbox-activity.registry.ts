import { Injectable } from '@nestjs/common';

/**
 * In-memory record of which sandbox containers have a turn EXEC in flight right now, keyed by
 * `containerId`. Every turn flows through `DockerEngineRunner.run` — the single exec chokepoint for
 * all callers (turn-runner, agent-session-manager, plan-review, auto-fix, acceptance-gate) — which
 * brackets the exec with {@link enter}/{@link leave}. The thread-sandbox reaper consults {@link isBusy}
 * so it never tears down a container mid-turn (which would kill a live build/plan/auto-fix turn).
 *
 * Ref-counted: a container may legitimately have more than one concurrent exec (defensive), so it is
 * only "idle" once every entered exec has left. Best-effort by design — if a reap and a turn-start
 * still interleave, `JobLifecycleService.ensureContainer` re-attaches (with the reset notice) as the
 * safety net. Process-local (one host composes the harness), so a plain Map is sufficient.
 */
@Injectable()
export class SandboxActivityRegistry {
  private readonly inFlight = new Map<string, number>();

  /** Mark an exec as started on `containerId`. */
  enter(containerId: string): void {
    this.inFlight.set(containerId, (this.inFlight.get(containerId) ?? 0) + 1);
  }

  /** Mark an exec as finished on `containerId`. */
  leave(containerId: string): void {
    const n = (this.inFlight.get(containerId) ?? 0) - 1;
    if (n > 0) this.inFlight.set(containerId, n);
    else this.inFlight.delete(containerId);
  }

  /** True while at least one exec is in flight on `containerId`. */
  isBusy(containerId: string): boolean {
    return (this.inFlight.get(containerId) ?? 0) > 0;
  }

  /** Run `fn` bracketed by {@link enter}/{@link leave} (the leave runs even if `fn` throws). */
  async thread<T>(containerId: string, fn: () => Promise<T>): Promise<T> {
    this.enter(containerId);
    try {
      return await fn();
    } finally {
      this.leave(containerId);
    }
  }
}
