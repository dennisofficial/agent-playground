/**
 * The thin CONTAINER-ENGINE seam (Phase 6) — the same shape as the Redis port (redis.port.ts).
 *
 * `ContainerManagerService` spawns + reconciles per-workspace sandbox containers, but it must NEVER
 * touch a real Docker socket from a unit test. So — exactly like the Redis transport — every Docker op
 * the manager needs funnels through this narrow port: the production binding (`DockerodeAdapter`) wraps
 * a `dockerode` client over the host Docker socket; the test binding is a deterministic in-memory fake
 * (`InMemoryContainerEngine`). The manager depends ONLY on this interface, so create/find/reconcile
 * unit-test with no daemon and no socket.
 *
 * The surface is intentionally minimal — only the ops the manager actually calls. Add one here (and to
 * BOTH the adapter and the fake) only when a new need appears.
 */

/** The DI token for the container-engine port (the production dockerode binding / the test fake). */
export const CONTAINER_ENGINE = Symbol('CONTAINER_ENGINE');

/** Labels are how the manager reconciles its in-memory registry from a running Docker host. */
export type ContainerLabels = Record<string, string>;

/** The create spec — a DELIBERATELY SMALL projection of dockerode's ContainerCreateOptions, holding
 * only the fields the manager sets. The adapter maps this onto the dockerode shape; the fake records it
 * verbatim so a test can assert privileged/labels/no-ports/env/limits without a real engine. */
export interface CreateContainerSpec {
  /** Container name — `agent-ws-<uuid>` (sanitized). */
  name: string;
  /** The sandbox base image (`WORKSPACE_IMAGE`). */
  image: string;
  /** Env injected as `KEY=value` strings (REDIS_URL, WORKSPACE_ID, DAEMON_BOOTSTRAP_TOKEN). */
  env: string[];
  /** Managed labels (`com.agent.*`) — the reconcile key. */
  labels: ContainerLabels;
  /** Privileged mode — inner DinD needs it (the locked tradeoff). */
  privileged: boolean;
  /** The OCI runtime (default a privileged runtime; reserve a `sysbox-runc` switch). */
  runtime?: string;
  /** Volume binds, e.g. `<vol>:/var/lib/docker` (the per-sandbox inner-docker storage). */
  binds: string[];
  /** Docker restart policy name — `unless-stopped` so a sandbox survives a host reboot. */
  restartPolicy: string;
  /** Hard memory limit in bytes (HostConfig.Memory). */
  memoryBytes?: number;
  /** CPU quota in units of 1e-9 CPUs (HostConfig.NanoCpus) — e.g. 2 CPUs = 2_000_000_000. */
  nanoCpus?: number;
  /** Max process count (HostConfig.PidsLimit) — a fork-bomb backstop. */
  pidsLimit?: number;
}

/** A created/looked-up container handle — opaque id + the labels Docker reports for it. */
export interface ContainerHandle {
  id: string;
  labels: ContainerLabels;
}

/** One container as `listContainers` reports it (the manager parses labels off this). */
export interface ContainerSummary {
  id: string;
  /** The container's names as Docker reports them (leading-slash form preserved). */
  names: string[];
  labels: ContainerLabels;
  /** Running/exited/created/… — the manager records it as the registry status. */
  state: string;
}

/** Filters for `listContainers` — `all` includes stopped; `label` matches `key` or `key=value`. */
export interface ListContainersFilter {
  all?: boolean;
  label?: string[];
}

/**
 * The minimal Docker surface Phase 6 needs. Every method is async (the dockerode client is async) and
 * id-based after create, so the manager never holds a live dockerode object — only opaque ids.
 */
export interface ContainerEnginePort {
  /** Create a container from the spec; resolves its handle (id + labels). Does NOT start it. */
  createContainer(spec: CreateContainerSpec): Promise<ContainerHandle>;

  /** Start a previously-created container by id. */
  startContainer(id: string): Promise<void>;

  /** Stop a running container by id (best-effort; an already-stopped container is not an error). */
  stopContainer(id: string): Promise<void>;

  /** Remove a container by id (force — removes even if running). */
  removeContainer(id: string): Promise<void>;

  /** List containers, optionally including stopped and filtered by label. */
  listContainers(filter?: ListContainersFilter): Promise<ContainerSummary[]>;

  /** Inspect one container's current labels + state, or undefined if it's gone. */
  inspectContainer(id: string): Promise<ContainerSummary | undefined>;
}
