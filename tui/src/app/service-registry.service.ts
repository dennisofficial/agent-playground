import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  jobDir,
  jobLogsDir,
  jobServicesFile,
  serviceLogFile,
} from "../domain/paths.js";
import {
  EServiceStatus,
  isRunning,
  renderServiceList,
  type ServiceEntry,
} from "../domain/services.js";
import { killGroup, logTail, spawnService } from "./service-process.js";
import { installReaperHandlers, reapGracefully } from "./service-reaper.js";
import type { ServiceActions } from "./tools/tool.js";

/**
 * How long `start` waits before answering, in ms. Long enough for `command not found` to land — the
 * shell reports that within a millisecond or two — and short enough to be invisible beside the tool
 * round trip it rides on. It is not a health check: a server that takes a minute to bind is running.
 */
const SETTLE_MS = 250;

/**
 * The job's long-lived processes, and the first thing in `app/` scoped to a JOB.
 *
 * Every other keyed registry here is by thread (`conversation-store.registry.ts`, `turn-lanes.ts`),
 * session or account, and none of those is the right grain: a service must survive a turn, a session,
 * a thread seam and a phase seam, and the only scope that outlives all four is the job.
 *
 * It has to be a **DI singleton** rather than anything a tool closure captures. Tool handlers are
 * built once per thread-open and re-wrapped per `query()`, so a handler's reachable state is
 * thread-scoped by construction and process-scoped by injection, with nothing in between — a map held
 * in the closure would give each thread its own services and quietly break the promise.
 *
 * Nothing outlives Atlas. The reaping that guarantees that is slice 05's; this class owns the map,
 * the spawn and the on-disk mirror.
 */
@Injectable()
export class ServiceRegistryService
  implements ServiceActions, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ServiceRegistryService.name);
  private readonly byJob = new Map<string, ServiceEntry[]>();
  private uninstallReaper: (() => void) | null = null;

  /**
   * The signal and exit handlers — see `service-reaper.ts`. Installed from the registry rather than
   * from `main.tsx` because the registry is the only thing that knows there is anything to reap, and
   * its lifetime is exactly the window in which that is true.
   */
  onModuleInit(): void {
    this.uninstallReaper = installReaperHandlers({
      target: this,
      warn: (message) => this.logger.warn(message),
    });
  }

  /**
   * The graceful path, reached from the in-app quit. The handlers come off first: this reap and the
   * signal handlers' reap are the same act, and leaving them armed would have a quit that re-raises
   * do it twice.
   */
  async onModuleDestroy(): Promise<void> {
    this.uninstallReaper?.();
    this.uninstallReaper = null;
    await reapGracefully({
      target: this,
      warn: (message) => this.logger.warn(message),
    });
  }

  /** The rows, for anything rendering them. The tool verbs below answer in prose instead. */
  listFor(jobId: string): readonly ServiceEntry[] {
    return this.byJob.get(jobId) ?? [];
  }

  /**
   * Every service in every job, unfiltered — for the reaper, which asks a different liveness
   * question from the one a human is shown, and for the UI signals that count what a quit would end.
   * Callers filter with the predicates in `domain/services.ts`.
   */
  allServices(): readonly ServiceEntry[] {
    return [...this.byJob.values()].flat();
  }

  async start(args: {
    jobId: string;
    command: string;
    description: string;
    cwd: string;
  }): Promise<string> {
    // Short because the model retypes it into `service_stop`. It is safe as a filename because
    // `serviceLogFile` checks containment, not because of how it is shaped.
    const id = randomUUID().slice(0, 8);
    const logPath = serviceLogFile({ jobId: args.jobId, serviceId: id });
    mkdirSync(jobLogsDir(args.jobId), { recursive: true });

    const spawned = spawnService({
      command: args.command,
      cwd: args.cwd,
      logPath,
    });
    const entry: ServiceEntry = {
      id,
      jobId: args.jobId,
      command: args.command,
      description: args.description,
      cwd: args.cwd,
      pid: spawned.pid,
      pgid: spawned.pgid,
      logPath,
      startedAt: Date.now(),
      status: EServiceStatus.running,
    };
    this.entriesFor(args.jobId).push(entry);
    this.persist(args.jobId);
    this.watchExit({ jobId: args.jobId, entry, exited: spawned.exited });

    // A command that does not exist spawns perfectly well and dies milliseconds later with 127, so
    // "Started" would be a lie the model then reasons about as a running server. One short settle
    // turns the commonest real failure into an answer instead of a log file nobody goes back for.
    await Bun.sleep(SETTLE_MS);
    if (entry.status !== EServiceStatus.running) {
      const tail = logTail({ logPath, lines: 5 });
      return `\`${id}\` (${args.description}) exited immediately with code ${entry.exitCode ?? "unknown"} — it is not running.\n  log: ${logPath}${tail ? `\n\n${tail}` : ""}`;
    }

    return `Started ${id} (pid ${entry.pid}) — ${args.description}\n  log: ${logPath}\n\nIt keeps running after this turn ends. Read the log with \`Read\` or \`Bash\`; \`service_stop\` with the id above ends it.`;
  }

  async stop(args: { jobId: string; id: string }): Promise<string> {
    const entry = this.listFor(args.jobId).find((row) => row.id === args.id);
    if (!entry) {
      return `No service \`${args.id}\` in this job. \`service_list\` shows what there is.`;
    }
    if (entry.status !== EServiceStatus.running) {
      return `\`${args.id}\` (${entry.description}) was already gone — it is ${entry.status}. Nothing to stop.`;
    }
    const signalled = killGroup({ pgid: entry.pgid, signal: "SIGTERM" });
    // `killed` only where we actually killed something. A group that was already gone is `exited` —
    // claiming otherwise would be Atlas taking credit for a death it had nothing to do with, and
    // `killed` is the status the human reads as "I stopped this".
    entry.status = signalled ? EServiceStatus.killed : EServiceStatus.exited;
    this.persist(args.jobId);
    return signalled
      ? `Stopped \`${args.id}\` — ${entry.description}. Its log is still at ${entry.logPath}.`
      : `\`${args.id}\` (${entry.description}) had already exited on its own. Its log is still at ${entry.logPath}.`;
  }

  async list(args: { jobId: string }): Promise<string> {
    return renderServiceList({
      entries: this.listFor(args.jobId),
      now: Date.now(),
    });
  }

  /**
   * Kill everything this job owns and forget it.
   *
   * Called when the job is DELETED and when its claim is RELEASED. Deletion removes `jobDir`, which
   * holds both the logs and the only record of what was running — doing that while a group is alive
   * orphans the tree and destroys the evidence at the same time, which is the leak this design
   * rejected. A claim release means another Atlas instance may now be driving the job, and children
   * left behind would be running with nobody watching them.
   *
   * Synchronous, and deliberately: it is also reachable from an exit path where nothing awaits.
   */
  reapJob(jobId: string): string[] {
    const entries = this.byJob.get(jobId);
    if (!entries) return [];
    const killed: string[] = [];
    for (const entry of entries) {
      if (entry.status !== EServiceStatus.running) continue;
      try {
        // Only a group we actually signalled becomes `killed`. One that ignored SIGTERM, or that we
        // may not signal, stays `running` — which is what leaves it visible to the two things that
        // can still catch it: slice 05's exit backstop, which sweeps `running` entries, and the
        // deferred reconcile, which is the entire reason `services.json` records a pgid. Recording
        // an optimistic `killed` here would tell every remaining layer the leak was handled.
        if (!killGroup({ pgid: entry.pgid, signal: "SIGTERM" })) continue;
        killed.push(entry.id);
        entry.status = EServiceStatus.killed;
      } catch (error) {
        // A best-effort sweep, unlike `stop()` where a throw is the model's answer. This runs from a
        // job deletion that has already removed the row and from a React effect, and one unkillable
        // group must not abort the loop, skip the persist below, or leave the job in the map.
        this.logger.warn(`could not reap service ${entry.id}: ${String(error)}`);
      }
    }
    // Persist BEFORE forgetting, so a mirror left behind by a deletion that then fails still says
    // these were stopped rather than claiming they are live.
    this.persist(jobId);
    this.byJob.delete(jobId);
    return killed;
  }

  /**
   * Signal every running group in every job — what quitting Atlas does, as against `reapJob`'s one.
   *
   * Returns the entries actually SIGNALLED, which is what makes the SIGTERM → grace → SIGKILL
   * escalation possible: a group that ignored the first signal is already recorded as `killed`, so
   * a second sweep of "what is running" would find nothing to insist on.
   *
   * The jobs stay in the map, unlike a deletion. Atlas is going away, not forgetting these jobs, and
   * the exit backstop still has to be able to see them.
   */
  reapAll(args: { signal: NodeJS.Signals }): ServiceEntry[] {
    const signalled: ServiceEntry[] = [];
    for (const [jobId, entries] of this.byJob) {
      let touched = false;
      for (const entry of entries) {
        if (!isRunning(entry)) continue;
        try {
          // Same rule as `reapJob`: only a group we actually signalled becomes `killed`. One that is
          // already gone is left alone rather than credited to a kill Atlas did not make.
          if (!killGroup({ pgid: entry.pgid, signal: args.signal })) continue;
          entry.status = EServiceStatus.killed;
          signalled.push(entry);
          touched = true;
        } catch (error) {
          // Best-effort, and for a harder reason than `reapJob`'s: this runs on the way out of the
          // process, where one unsignallable group aborting the loop would leak every service after
          // it in the map.
          this.logger.warn(`could not reap service ${entry.id}: ${String(error)}`);
        }
      }
      if (touched) this.persist(jobId);
    }
    return signalled;
  }

  private entriesFor(jobId: string): ServiceEntry[] {
    const existing = this.byJob.get(jobId);
    if (existing) return existing;
    const created: ServiceEntry[] = [];
    this.byJob.set(jobId, created);
    return created;
  }

  /**
   * Exit detection, and no notification.
   *
   * The model is not told. That is the report channel this design deliberately does not have — a
   * service has no completion semantics, and work that wants a result is finite work, which reports
   * back inside its own turn by holding it. The model finds out by calling `service_list` or reading
   * the log, which is what it already does.
   */
  private watchExit(args: {
    jobId: string;
    entry: ServiceEntry;
    exited: Promise<number>;
  }): void {
    void args.exited
      .then((code) => {
        // A job reaped or deleted while this was pending has dropped the entry; writing its mirror
        // back would resurrect a file the deletion just removed.
        if (!this.listFor(args.jobId).includes(args.entry)) return;
        args.entry.exitCode = code;
        // Only `running` moves. A stop has already recorded `killed`, which is the more honest
        // account of why the process is gone, and the code is kept beside it either way.
        if (args.entry.status === EServiceStatus.running) {
          args.entry.status = EServiceStatus.exited;
        }
        this.persist(args.jobId);
      })
      .catch((error: unknown) => {
        this.logger.warn(`service ${args.entry.id} exit watch failed: ${String(error)}`);
      });
  }

  /**
   * The mirror. Nothing in this job reads it back — it exists so the deferred crash-orphan reconcile
   * has a pid and a pgid to match against.
   *
   * A failure here is logged and swallowed on purpose: the process is already running, and turning a
   * successful start into a thrown tool result over a bookkeeping file would lose the id the caller
   * needs to stop it.
   */
  private persist(jobId: string): void {
    try {
      mkdirSync(jobDir(jobId), { recursive: true });
      writeFileSync(
        jobServicesFile(jobId),
        `${JSON.stringify(this.listFor(jobId), null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      this.logger.warn(`could not write services.json for ${jobId}: ${String(error)}`);
    }
  }
}
