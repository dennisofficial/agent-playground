import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
  /** Whether the service opts INTO preview exposure. Back-compat default: absent → exposed. */
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

/**
 * Read every `atlas-svc` marker in `dir` (the host supervisor dir). Skips non-`.json` files, ids that
 * fail {@link SERVICE_ID_RE}, and markers that are corrupt / mid-write (unparseable JSON). Parses the
 * back-compat optional fields: `port` = a number or null (missing → null), `expose` = true unless the
 * marker explicitly sets `expose:false`. Returns [] when `dir` can't be listed.
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
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
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
    markers.push({
      id,
      // `name` feeds the public preview host + the Caddy admin `@id` path, so it MUST satisfy the same
      // path-safe regex as the id. A sandbox process could drop a marker whose filename passes the guard
      // but whose JSON `name` is arbitrary (e.g. `../../config/...`); fall back to the validated `id`.
      name: typeof parsed.name === 'string' && SERVICE_ID_RE.test(parsed.name) ? parsed.name : id,
      cmd: typeof parsed.cmd === 'string' ? parsed.cmd : '',
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      pgid: typeof parsed.pgid === 'number' ? parsed.pgid : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      // Only a real TCP port routes; reject NaN/negative/out-of-range so a hand-crafted marker can't
      // produce a broken `<host>:NaN` upstream dial (matches atlas-svc's own 1–65535 guard).
      port:
        typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port >= 1 && parsed.port <= 65535
          ? parsed.port
          : null,
      expose: parsed.expose !== false,
      logBytes,
      logUpdatedAt,
    });
  }
  return markers;
}
