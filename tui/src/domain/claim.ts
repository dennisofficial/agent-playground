/**
 * Which terminal is driving a job.
 *
 * One user, one machine, several tiles — so this is NOT a lock in the concurrency sense. It never
 * refuses. Its whole job is to answer "is someone else already on this?" before you open, rather
 * than after, and to make the answer wrong for as short a time as possible when a tile dies badly.
 *
 * Liveness is asked of the OS (`process.kill(pid, 0)`), never inferred from a heartbeat: a dead
 * process is dead the instant it dies, whereas a timestamp is only ever stale-in-N-seconds. The
 * probe is injected so this module stays pure and the rules stay testable without spawning anything.
 *
 * `startedAt` exists solely to survive pid reuse. The kernel will hand out pid 4711 again eventually
 * and the new holder must not inherit the old one's claim; comparing the recorded start against the
 * claim narrows that window to nothing that matters. The cost of being wrong is a takeover prompt
 * for a job nobody holds, which is a keypress, not a loss.
 */

export type Claim = {
  pid: number;
  /** ms epoch, when the CLAIMING PROCESS started — not when the claim was written. */
  startedAt: number;
  /** Controlling terminal (`/dev/ttys004`), when there is one. Shown to say WHERE, never compared. */
  tty: string | null;
};

export enum EClaimState {
  /** Unclaimed, or claimed by a process that no longer exists. Open it without ceremony. */
  free = 'free',
  /** This process holds it. Re-entering your own job is not a takeover. */
  mine = 'mine',
  /** Another live terminal is driving. Opening it means taking it from them. */
  held = 'held',
}

export function serialiseClaim(claim: Claim): string {
  return JSON.stringify(claim);
}

/**
 * Tolerant by design. A truncated or hand-mangled claim file must read as "unclaimed" rather than
 * throw — the failure mode of a corrupt claim should be an extra takeover prompt, never a tile that
 * cannot open its own job.
 */
export function parseClaim(raw: string): Claim | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const { pid, startedAt, tty } = record;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;

  return { pid, startedAt, tty: typeof tty === 'string' ? tty : null };
}

/**
 * `isAlive` is the OS probe. It is only ever called for a claim held by someone else — asking
 * whether we ourselves exist would be silly, and asking about a missing claim would be a lie.
 */
export function claimState(args: {
  claim: Claim | null;
  selfPid: number;
  isAlive: (pid: number) => boolean;
}): EClaimState {
  if (!args.claim) return EClaimState.free;
  if (args.claim.pid === args.selfPid) return EClaimState.mine;
  return args.isAlive(args.claim.pid) ? EClaimState.held : EClaimState.free;
}

/**
 * The lockfile footgun, as a function.
 *
 * After a takeover the file on disk belongs to the NEW tile, so the old one must not remove it on
 * its way out — it would silently unclaim a job that someone else is actively driving, and the bug
 * only shows up when the two exits happen in the wrong order. Cleanup is allowed only while the
 * claim still names you.
 */
export function mayReleaseClaim(args: {
  claim: Claim | null;
  selfPid: number;
}): boolean {
  return args.claim?.pid === args.selfPid;
}
