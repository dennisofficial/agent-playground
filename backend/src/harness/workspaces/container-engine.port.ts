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
  /** The Docker network the sandbox joins (HostConfig.NetworkMode) — so the daemon can reach a
   * service-DNS Redis (e.g. `agent-playground-redis`) on the compose network. Undefined → Docker's
   * default bridge (no service DNS). The sandbox still publishes NO ports inbound. */
  network?: string;
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

/** One managed volume as `listVolumes`/`inspectVolume` report it (the sweep parses labels off this). */
export interface VolumeSummary {
  name: string;
  labels: ContainerLabels;
}

/** Filters for `listVolumes` — `label` matches `key` or `key=value` (same semantics as containers). */
export interface ListVolumesFilter {
  label?: string[];
}

/** Build a generic base image from a SMALL, EXPLICIT file set (so we never tar the whole monorepo as
 * the build context). Mirrors `build-daemon.sh`'s `docker build -f <dockerfile> -t <tag> <context>`. */
export interface BuildImageSpec {
  /** The build-context root the `src` paths are relative to (the repo root). */
  contextDir: string;
  /** The files dockerode tars into the context — the Dockerfile + every path it `COPY`s (currently
   * just `backend/src/daemon/entrypoint.sh`). Keeping this explicit is what keeps the context tiny. */
  src: string[];
  /** The Dockerfile path, RELATIVE to `contextDir` (e.g. `backend/src/daemon/Dockerfile`). */
  dockerfile: string;
  /** The image tag to produce (e.g. `agent-workspace-base`). */
  tag: string;
  /** `--pull` — refresh the FROM base image. */
  pull?: boolean;
  /** `--no-cache`. */
  noCache?: boolean;
}

/** Run the one-shot daemon-BUILD container that (re)populates the daemon-build volume — the in-process
 * equivalent of `build-daemon.sh` step 3 (`docker run --entrypoint bash … daemon-build-inner.sh`). */
export interface RunBuildContainerSpec {
  /** The base image the build runs inside (same image the sandboxes use). */
  image: string;
  /** The host repo root, bind-mounted READ-ONLY at `/src` (the inner script rsyncs `/src` → `/build`).
   * NOTE: a Docker-out-of-Docker host interprets this as a HOST path — set `REPO_ROOT` if the slack-app
   * itself runs in a container whose repo path differs from the host's. */
  repoRoot: string;
  /** The daemon-build output volume, mounted at `/build`. */
  buildVolume: string;
  /** The persistent pnpm-store volume, mounted at `/pnpm-store` (frozen-lockfile install ≈ no-op). */
  storeVolume: string;
  /** The in-container path of the build script to run (`/src/backend/scripts/daemon-build-inner.sh`). */
  innerScript: string;
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

  /** Create a named volume with the given labels (idempotent — an existing volume of the same name is
   * returned). The manager labels each per-sandbox volume so the boot orphan-sweep can find leaked ones
   * (Docker label filters apply to volume OBJECTS, so a bind-auto-created volume — which carries no
   * labels — is invisible to `listVolumes({label})`; we must create+label it up front). */
  createVolume(name: string, labels?: ContainerLabels): Promise<void>;

  /** Remove a named volume (best-effort — a missing volume is a no-op; a volume still in use throws). */
  removeVolume(name: string): Promise<void>;

  /** List volumes, optionally filtered by label (`key` or `key=value`). */
  listVolumes(filter?: ListVolumesFilter): Promise<VolumeSummary[]>;

  /** Inspect one volume's labels, or undefined if it doesn't exist. */
  inspectVolume(name: string): Promise<VolumeSummary | undefined>;

  /** Whether an image with this name/tag exists locally (`docker image inspect`). Drives the
   * provisioner's "build the base image only if missing" check. */
  imagePresent(image: string): Promise<boolean>;

  /** Build the generic workspace base image from a small explicit file set. Drains the build stream and
   * rejects on a build error (a Dockerfile-step failure surfaces in the stream, not as a throw). */
  buildImage(spec: BuildImageSpec): Promise<void>;

  /** Run the one-shot daemon-build container to (re)populate the daemon-build volume. Rejects on a
   * non-zero container exit (with captured tail logs). The host's slack-app calls this AT BOOT so a
   * deploy no longer needs a manual `pnpm daemon:build`. */
  runBuildContainer(spec: RunBuildContainerSpec): Promise<void>;

  /** Pre-spawn guard: whether the mounted daemon build actually contains its entry file. Runs a
   * throwaway container that mounts `volume` read-only at `/daemon` and `test -f`s `entryPath` — volume
   * existence alone is insufficient (a named volume's contents aren't host-readable on Docker Desktop,
   * and a half-populated volume would still "exist"). `false` ⇒ the host fails loudly with "run
   * `pnpm daemon:build`" rather than spawning a sandbox whose daemon can't start. */
  daemonBuildPresent(
    volume: string,
    image: string,
    entryPath: string,
  ): Promise<boolean>;
}
