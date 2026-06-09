import { getEngine } from './engines/index.js';
import type { RunWorkerArgs, WorkerEngineName } from './engines/types.js';
import type { Workspace } from './workspace.js';

/**
 * WHERE a worker's engine actually executes — the disposable half of the worker model (Workspace is
 * the durable half). Stage 0 ships only `localRuntime` (in-process, on the host). This interface is
 * the swap point for out-of-process execution: a future ContainerRuntime (one container per job) or
 * CloudRuntime (remote microVM) implements the same `run` so callers (worker.ts) don't change — only
 * the transport for `onEvent`/`signal` and the way the workspace branch is materialized differ.
 *
 * Kept deliberately thin: it owns "where compute runs"; Workspace owns "where the branch/files live."
 */
export interface WorkerRuntime {
  run(
    engine: WorkerEngineName,
    args: RunWorkerArgs & { workspace?: Workspace },
  ): Promise<{ result: string; sessionId?: string }>;
}

/**
 * In-process execution on the host — identical to the pre-isolation behavior, now scoped to the job's
 * worktree via `args.cwd` (set by the caller; ROOT for read-only plan jobs). `workspace` is unused
 * here — it rides along for the future ContainerRuntime, which needs the branch to clone into a
 * container rather than a local `cwd`.
 */
export const localRuntime: WorkerRuntime = {
  run(engine, { workspace: _workspace, ...args }) {
    return getEngine(engine).run(args);
  },
};
