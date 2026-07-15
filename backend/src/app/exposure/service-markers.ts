import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceLivenessProbe } from '../sandbox/sandbox-provider.port';
import { isValidExposedServiceName } from './exposure-naming';

/**
 * One supervised process's durable `atlas-svc` marker (see `backend/sandbox/atlas-svc`), read from the
 * host mirror of `/.atlas/supervisor`. Shared by the web surface's `services()` listing AND the preview
 * reconciler so both agree on which services exist, their advertised `port`, and whether they opt into
 * exposure — no drift between what the UI shows and what Caddy publishes.
 */
export type ServiceMarker = {
  name: string;
  cmd: string;
  pid: number | null;
  pgid: number | null;
  startedAt: string | null;
  /** The dev-server port the process listens on, captured via `atlas-svc --port`; null when unmarked. */
  port: number | null;
  /** Whether the service opts INTO preview exposure. Secure-by-default: absent → NOT exposed. */
  expose: boolean;
  /** Size of the paired `<id>.log`, 0 if none yet. */
  logBytes: number;
  /** Last-modified time of the log file — a recency signal, not a liveness guarantee. */
  logUpdatedAt: string | null;
};

/** Matches `atlas-svc`'s own `--name` validation — also doubles as the marker-file path-safety guard. */
const SERVICE_ID_RE = /^[a-z0-9_-]+$/;

/** The marker `id` plus its parsed fields — `id` is the marker filename stem, distinct from `name`. */
export type ReadServiceMarker = ServiceMarker & { id: string };

/** A supervised process's live status: `running`, `stopped` (marker present, process gone), or `unknown`
 *  (couldn't probe — no container yet, null pgid/startedAt, or a transient exec failure). */
export type ServiceStatus = 'running' | 'stopped' | 'unknown';

/** Slack for the generation gate: `atlas-svc` markers are second-precision (`date +%FT%TZ`) while Docker
 *  `StartedAt` is sub-second, so a service started in the SAME second as container boot can truncate just
 *  below it. Only treat a marker as previous-generation when it predates boot by more than this — genuine
 *  stale markers predate boot by minutes/hours, so the tolerance never lets a reused old pgid through. */
export const GENERATION_SKEW_MS = 2_000;

/**
 * Map one supervised process's durable marker + the container-wide liveness probe to its live status —
 * the SINGLE gate shared by the web surface's PORTS listing AND the preview reconciler's routing, so the
 * URL shown and the route published can never disagree. The container-GENERATION gate is load-bearing: a
 * marker whose `startedAt` predates the current container boot is from a previous PID namespace and is
 * dead even if its old pgid was reused and now answers `kill -0` — so we reject it BEFORE consulting
 * `alive`. A transient probe failure (`unknown`) is never mapped to `stopped` (see {@link ServiceLivenessProbe}).
 */
export function serviceStatus(
  marker: Pick<ServiceMarker, 'pgid' | 'startedAt'>,
  probe: ServiceLivenessProbe,
): ServiceStatus {
  if (probe.status === 'unknown') return 'unknown';
  if (probe.status === 'down') return 'stopped'; // no running container ⇒ every marker is dead
  // probe.status === 'up' — verify the marker belongs to THIS container generation before trusting alive.
  if (marker.pgid == null || marker.startedAt == null) return 'unknown';
  const started = Date.parse(marker.startedAt);
  const generation = Date.parse(probe.containerStartedAt);
  if (!Number.isFinite(started) || !Number.isFinite(generation))
    return 'unknown';
  if (started < generation - GENERATION_SKEW_MS) return 'stopped'; // previous container — reused pgid must not read as running
  return probe.alive.includes(marker.pgid) ? 'running' : 'stopped';
}

/**
 * Read every `atlas-svc` marker in `dir` (the host supervisor dir). Skips non-`.json` files, ids that
 * fail {@link SERVICE_ID_RE}, and markers that are corrupt / mid-write (unparseable JSON). Parses the
 * optional fields: `port` = a number or null (missing → null), `expose` = false unless the marker
 * explicitly sets `expose:true` (secure-by-default — public exposure is opt-in). Returns [] when `dir`
 * can't be listed.
 */
export function readServiceMarkers(dir: string): ReadServiceMarker[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const markers: ReadServiceMarker[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!SERVICE_ID_RE.test(id)) continue; // defensive — atlas-svc only ever writes validated names
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      continue; // a marker mid-write / corrupt — skip rather than fail the whole list
    }
    let logBytes = 0;
    let logUpdatedAt: string | null = null;
    try {
      const st = statSync(join(dir, `${id}.log`));
      logBytes = st.size;
      logUpdatedAt = st.mtime.toISOString();
    } catch {
      /* no log yet */
    }
    const name =
      typeof parsed.name === 'string' && SERVICE_ID_RE.test(parsed.name)
        ? parsed.name
        : id;
    const port =
      typeof parsed.port === 'number' &&
      Number.isInteger(parsed.port) &&
      parsed.port >= 1 &&
      parsed.port <= 65535
        ? parsed.port
        : null;
    markers.push({
      id,
      // `name` feeds the public preview host + the Caddy admin `@id` path, so it MUST satisfy the same
      // path-safe regex as the id. A sandbox process could drop a marker whose filename passes the guard
      // but whose JSON `name` is arbitrary (e.g. `../../config/...`); fall back to the validated `id`.
      name,
      cmd: typeof parsed.cmd === 'string' ? parsed.cmd : '',
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      pgid: typeof parsed.pgid === 'number' ? parsed.pgid : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      // Only a real TCP port routes; reject NaN/negative/out-of-range so a hand-crafted marker can't
      // produce a broken `<host>:NaN` upstream dial (matches atlas-svc's own 1–65535 guard).
      port,
      // Secure-by-default: expose ONLY when the marker explicitly opts in AND the name can form a valid
      // public hostname. Absent/false ⇒ internal (matches the atlas-svc --expose default).
      expose: parsed.expose === true && isValidExposedServiceName(name),
      logBytes,
      logUpdatedAt,
    });
  }
  return markers;
}

export type PortState = 'exposed' | 'internal' | null;
/** Tri-state for the sidebar badge. `hasUrl` answers "would this marker get a public preview URL"
 *  (ExposureService.urlFor != null), so exposure being globally disabled collapses to internal/null. */
export function derivePortState(
  markers: ReadServiceMarker[],
  probe: ServiceLivenessProbe,
  hasUrl: (m: ReadServiceMarker) => boolean,
): PortState {
  const running = markers.filter((m) => serviceStatus(m, probe) === 'running');
  if (running.length === 0) return null;
  return running.some((m) => m.port != null && m.expose && hasUrl(m))
    ? 'exposed'
    : 'internal';
}
