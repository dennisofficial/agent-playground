import { mayStillBeAlive, type ServiceEntry } from "../domain/services.js";
import { insist, REAP_GRACE_MS } from "./service-reap.js";

/**
 * Nothing outlives Atlas.
 *
 * That is the whole promise of the service facility, and it is the half no other layer can keep:
 * a service is a DETACHED process-group leader, so unlike a turn — which is a subprocess of this
 * one and dies with it — it survives the death of the app that started it unless something goes and
 * kills it. Before this slice the app had exactly one lifecycle hook anywhere and no `process.on`
 * handler at all, because nothing needed reaping.
 *
 * Three layers, weakest last, because each covers an exit the one above it cannot reach:
 *
 * 1. **`onModuleDestroy`** — the in-app ctrl+c quit, which reaches Nest through
 *    `renderer.destroy()` → `main.tsx`'s `destroy` hook. SIGTERM, a short grace, then SIGKILL, so a
 *    dev server gets its chance to shut down cleanly. `context.close()` is `void`-ed there, so this
 *    layer must never be RELIED on to finish.
 * 2. **`SIGINT` / `SIGTERM` / `SIGHUP`** — a terminal closing, an external `kill`, a ctrl+c that
 *    arrives while the renderer is not listening. None of these touches the renderer, so without a
 *    handler the process dies and the whole tree keeps running.
 * 3. **`exit`** — the backstop. Synchronous work only, which is fine because `process.kill` is
 *    synchronous. It is NOT "the one that always runs", which this used to claim: layer 2 ends by
 *    re-raising with the default disposition, and death by signal does not run `exit` handlers at
 *    all. What it actually covers is the loop draining and an explicit `process.exit` — `main.tsx`'s
 *    top-level `catch` being the one in the tree today.
 *
 * Still not covered, and accepted: a **SIGKILL of Atlas**. No handler can run, so the tree leaks.
 * `services.json` records the pid and the pgid precisely so the deferred crash-orphan reconcile can
 * clean up after that one.
 */

/** The signals that mean "Atlas is going away" and can still be caught. */
export const REAP_SIGNALS: readonly NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
];

/**
 * What the reaper needs of the registry, and no more — so the layers can be driven by a test with a
 * hand-built target rather than a container.
 */
export type ReaperTarget = {
  /**
   * Signal every group that may still be alive, recording the kill. Returns the entries actually
   * SIGNALLED — which is what the escalation below comes back to, and is why a group the kernel
   * denied is not in it.
   */
  reapAll(args: { signal: NodeJS.Signals }): ServiceEntry[];
  /** Every service in every job. The caller filters — see `domain/services.ts`. */
  allServices(): readonly ServiceEntry[];
};

type Warn = (message: string) => void;

/**
 * Layers 1 and 2: ask, wait, insist.
 *
 * The escalation goes back to the entries it SIGNALLED rather than re-sweeping, and the reason is
 * not cost — a Map walk over a handful of entries is nothing. It is that the answer must not be
 * allowed to grow: a service started during the grace window is not something a quit already in
 * progress should be signalling. `mayStillBeAlive` is re-asked per entry, so anything that died
 * politely in the meantime is left alone.
 */
export async function reapGracefully(args: {
  target: ReaperTarget;
  warn: Warn;
  graceMs?: number;
}): Promise<void> {
  const signalled = args.target.reapAll({ signal: "SIGTERM" });
  if (signalled.length === 0) return;
  await Bun.sleep(args.graceMs ?? REAP_GRACE_MS);
  for (const entry of signalled) {
    if (!mayStillBeAlive(entry)) continue;
    insist({ entry, warn: args.warn });
  }
}

/**
 * Layer 3, the backstop — though not, as this once claimed, the one that always runs.
 *
 * It sweeps by `mayStillBeAlive` rather than by `running`, which is the one place this deviates from
 * the letter of the spec and does so deliberately: a graceful reap has already moved every service
 * to `killed`, so a `running`-only sweep would find nothing on exactly the exit path it exists to
 * back up. What matters here is whether the exit was ever OBSERVED, not what Atlas calls the row.
 *
 * Synchronous throughout, and it swallows everything: a throw inside an `exit` handler takes the
 * remaining entries with it, and by then there is nobody left to report to.
 */
export function reapNow(args: { target: ReaperTarget; warn: Warn }): void {
  for (const entry of args.target.allServices()) {
    if (!mayStillBeAlive(entry)) continue;
    insist({ entry, warn: args.warn });
  }
}

/**
 * What `installReaperHandlers` hands back, and the reason it is two verbs rather than one.
 *
 * The signal handlers and the exit backstop come off at DIFFERENT moments. Signals go first, before
 * any reaping starts, so a second ctrl+c reaches the default disposition and kills Atlas outright
 * instead of queueing behind a reap that is stuck. The exit handler stays armed through the grace,
 * which is the window where every service is signalled and none is confirmed dead — the worst
 * possible moment to have nothing armed, which is what dropping both up front used to do.
 *
 * Honest about what that buys today: it was measured, and the window is not currently REACHABLE.
 * OpenTUI's `destroy` does not exit the process, and a pending `Bun.sleep` holds the loop open, so
 * nothing on the quit path can reach `exit` mid-grace. This is insurance against the first
 * `process.exit` anyone adds to that path, not a race being fixed — kept because the cost is one
 * extra closure and the failure it would otherwise allow is silent and unrecoverable.
 */
export type ReaperHandles = {
  /** Layer 2 off. Called before reaping, on both quit paths. */
  disarmSignals: () => void;
  /** Layers 2 and 3 off. Called once the reap has finished, and idempotent. */
  disarmAll: () => void;
};

/**
 * Install layers 2 and 3 on the process.
 *
 * `terminate` is a real port rather than a test seam: it is "end this process the way the signal
 * asked", and re-raising is the only implementation an app should ever want. It is injectable so a
 * test can drive the handler without killing its own runner.
 */
export function installReaperHandlers(args: {
  target: ReaperTarget;
  warn: Warn;
  graceMs?: number;
  terminate?: (signal: NodeJS.Signals) => void;
}): ReaperHandles {
  const terminate =
    args.terminate ??
    ((signal: NodeJS.Signals) => {
      // The handler is gone by now, so this applies the default disposition — Atlas dies of the
      // signal it was sent, with the exit code that implies, rather than of a bare `process.exit`.
      process.kill(process.pid, signal);
    });

  const registered: Array<{
    event: NodeJS.Signals | "exit";
    handler: () => void;
  }> = [];

  const off = (predicate: (event: NodeJS.Signals | "exit") => boolean): void => {
    for (const entry of registered.splice(0)) {
      if (!predicate(entry.event)) {
        registered.push(entry);
        continue;
      }
      process.off(entry.event, entry.handler);
    }
  };

  const disarmSignals = (): void => off((event) => event !== "exit");
  const disarmAll = (): void => off(() => true);

  for (const signal of REAP_SIGNALS) {
    const handler = (): void => {
      // Signals come off FIRST, before anything can fail: a second signal must reach the default
      // disposition and kill Atlas outright rather than queue behind a reap that is stuck. The exit
      // backstop deliberately stays armed until the reap is done — see `ReaperHandles`.
      disarmSignals();
      void reapGracefully({
        target: args.target,
        warn: args.warn,
        ...(args.graceMs === undefined ? {} : { graceMs: args.graceMs }),
      })
        .catch((error: unknown) => args.warn(`reap on ${signal} failed: ${String(error)}`))
        .finally(() => {
          disarmAll();
          terminate(signal);
        });
    };
    process.on(signal, handler);
    registered.push({ event: signal, handler });
  }

  const onExit = (): void => reapNow({ target: args.target, warn: args.warn });
  process.on("exit", onExit);
  registered.push({ event: "exit", handler: onExit });

  return { disarmSignals, disarmAll };
}

