import { Injectable } from "@nestjs/common";
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import {
  claimState,
  EClaimState,
  mayReleaseClaim,
  parseClaim,
  serialiseClaim,
  type Claim,
} from "../domain/claim.js";
import { jobClaimFile, jobDir } from "../domain/paths.js";

/**
 * Which terminal is driving a job, on disk.
 *
 * A file rather than a database row for one reason: it can be WATCHED. `fs.watch` hands every other
 * tile the takeover the instant it happens, where a row would have to be polled — and a poll
 * interval is exactly the window in which two tiles both believe they are driving.
 *
 * Nothing here refuses. One user, one machine, several tiles: the claim exists so you can see a job
 * is busy BEFORE you open it, not to stop you.
 */
@Injectable()
export class ClaimService {
  /**
   * When THIS process started, not when the claim was written. It is the pid-reuse guard: the kernel
   * will hand out this pid again eventually, and the next holder must not inherit our claim.
   */
  private readonly startedAt = Date.now() - Math.round(process.uptime() * 1000);
  private readonly tty = controllingTty();

  read(jobId: string): Claim | null {
    try {
      return parseClaim(readFileSync(jobClaimFile(jobId), "utf8"));
    } catch {
      // No file, unreadable file — both mean nobody is holding it, which is the useful answer.
      return null;
    }
  }

  stateOf(jobId: string): EClaimState {
    return claimState({
      claim: this.read(jobId),
      selfPid: process.pid,
      isAlive,
    });
  }

  /** One read per job. The list needs every row's state at once and a per-row read is a per-row stat. */
  statesFor(jobIds: readonly string[]): Map<string, EClaimState> {
    return new Map(jobIds.map((jobId) => [jobId, this.stateOf(jobId)]));
  }

  /**
   * Takes the job, whoever had it. Last writer wins — that is the design, not a compromise: a tile
   * that died badly must never be able to lock you out of your own work.
   */
  acquire(jobId: string): void {
    const claim: Claim = {
      pid: process.pid,
      startedAt: this.startedAt,
      tty: this.tty,
    };
    mkdirSync(jobDir(jobId), { recursive: true });
    writeFileSync(jobClaimFile(jobId), serialiseClaim(claim), "utf8");
  }

  /**
   * Only ever removes OUR claim. After a takeover the file belongs to the tile that took the job,
   * and deleting it on the way out would silently unclaim a job someone else is actively driving —
   * a bug that only shows up when two exits happen in the wrong order.
   */
  release(jobId: string): void {
    if (!mayReleaseClaim({ claim: this.read(jobId), selfPid: process.pid })) {
      return;
    }
    try {
      rmSync(jobClaimFile(jobId));
    } catch {
      // Already gone. Releasing something nobody holds is a no-op, not a failure.
    }
  }

  /**
   * Calls back whenever the claim changes, and returns the unsubscribe.
   *
   * Watches the DIRECTORY rather than the file: the file may not exist yet when a tile starts
   * watching, and `fs.watch` on a missing path throws instead of waiting for it to appear.
   */
  watch(jobId: string, onChanged: () => void): () => void {
    mkdirSync(jobDir(jobId), { recursive: true });
    const watcher = watch(jobDir(jobId), (_event, filename) => {
      if (filename === "claim.json") onChanged();
    });
    return () => watcher.close();
  }
}

/**
 * Liveness, asked of the kernel. Signal 0 checks that a process exists without touching it.
 *
 * `EPERM` means it exists and belongs to someone else — alive, and the answer that matters. Only
 * `ESRCH` (no such process) frees the claim.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `/dev/ttys004` — the only true identity a tile has. It does not map to "the third pane down" in
 * anyone's head, so it is shown as a tiebreaker rather than as the answer.
 */
function controllingTty(): string | null {
  try {
    return process.stdout.isTTY ? readlinkSync("/dev/fd/1") : null;
  } catch {
    return null;
  }
}
