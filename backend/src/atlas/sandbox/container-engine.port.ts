/**
 * Atlas v2 — the CONTAINER_ENGINE port: the one narrow Docker seam the sandbox layer is built on.
 *
 * This is deliberately a thin, vendor-neutral wrapper over the handful of Docker operations the sandbox
 * manager needs — create a network, build/check an image, create + start a long-lived container, run a
 * one-shot **streamed exec** inside it (the workhorse — this is how the host drives an engine turn), and
 * stop/remove/list/inspect for lifecycle + boot adoption. Everything above it (the sandbox manager, the
 * docker engine-runner) speaks this interface, never `dockerode` directly, so the Docker client is a
 * single swappable provider and unit tests can bind a fake.
 *
 * Designed from first principles (v1's container stack is deleted) — no `harness/**` dependency.
 */

/** DI token for the container engine. */
export const CONTAINER_ENGINE = Symbol('CONTAINER_ENGINE');

/** A named volume mounted into the container (e.g. the per-sandbox inner-docker storage). */
export interface VolumeMount {
  /** The docker volume name (created if absent). */
  name: string;
  /** Absolute mount path inside the container. */
  path: string;
}

/** A published port mapping (host ← container). Used only by the dev-exposure follow-up. */
export interface PortMapping {
  containerPort: number;
  /** Host port to bind; omit to let Docker pick from the ephemeral range. */
  hostPort?: number;
  protocol?: 'tcp' | 'udp';
}

/** Everything needed to create (not yet start) a sandbox container. */
export interface CreateContainerSpec {
  /** Container name (Docker-unique; we derive it from the sandbox key). */
  name: string;
  /** Image tag to run. */
  image: string;
  /** Network to attach (created via `ensureNetwork` first). Omit → Docker default bridge. */
  network?: string;
  /** Bind mounts as `host:container[:ro]` strings (the worktree at /work, the agent-home, /refs:ro). */
  binds?: string[];
  /** Named-volume mounts (the inner /var/lib/docker storage). */
  volumes?: VolumeMount[];
  /** Labels — the SOURCE OF TRUTH for boot adoption + reaping (atlas.team/project/branch/job). */
  labels?: Record<string, string>;
  /** Env baked at create time. Secrets must NOT go here (they ride per-exec env instead). */
  env?: Record<string, string>;
  /** Run privileged (required for inner dockerd / DinD). */
  privileged?: boolean;
  /** Override the image entrypoint/cmd (PID 1). */
  cmd?: string[];
  /** Default working directory inside the container. */
  workingDir?: string;
  /** Published ports (dev-exposure follow-up; unused in the core build). */
  ports?: PortMapping[];
}

/** Options for a one-shot exec inside a running container. */
export interface ExecOptions {
  /** Run as this user (`uid` or `uid:gid`) — host-uid for worktree ownership parity. */
  user?: string;
  /** Per-exec env — this is where SECRETS (API keys, tokens) are passed, never on the container. */
  env?: Record<string, string>;
  /** Working directory for the exec. */
  cwd?: string;
  /** Optional stdin piped to the process (the engine turn spec JSON). */
  stdin?: string;
  /** Streamed stdout chunks (decoded utf-8). */
  onStdout?: (chunk: string) => void;
  /** Streamed stderr chunks (decoded utf-8). */
  onStderr?: (chunk: string) => void;
  /** Abort the exec (kills the stream). */
  signal?: AbortSignal;
}

/** The result of a finished exec. `stdout`/`stderr` accumulate the full streams for convenience. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A minimal view of a container, enough for lifecycle decisions + boot adoption. */
export interface ContainerInfo {
  id: string;
  name: string;
  /** 'running' | 'exited' | 'created' | … (Docker's state string). */
  state: string;
  labels: Record<string, string>;
}

/** Build a single image from a context directory. */
export interface BuildImageSpec {
  /** Absolute path to the build context (holds the Dockerfile + any copied assets). */
  contextDir: string;
  /** Dockerfile name relative to the context (default 'Dockerfile'). */
  dockerfile?: string;
  /** The tag to apply. */
  tag: string;
  /** Build args. */
  buildArgs?: Record<string, string>;
  /** Streamed build log lines. */
  onProgress?: (line: string) => void;
}

/**
 * The container engine — a thin, swappable Docker seam. All methods are idempotent where it makes
 * sense (`ensureNetwork`, `createContainer` by name) so a resume re-enters cleanly.
 */
export interface ContainerEngine {
  /** Create the named network if it doesn't exist (idempotent). */
  ensureNetwork(name: string): Promise<void>;

  /** True if an image with this tag exists locally. */
  imageExists(tag: string): Promise<boolean>;

  /** Build an image from a context dir. */
  buildImage(spec: BuildImageSpec): Promise<void>;

  /** Create a container (does not start it). Returns the container id. */
  createContainer(spec: CreateContainerSpec): Promise<string>;

  /** Start a created container. */
  start(id: string): Promise<void>;

  /** Run a one-shot streamed exec inside a running container; resolves when it exits. */
  exec(id: string, argv: string[], opts?: ExecOptions): Promise<ExecResult>;

  /** Stop a running container (SIGTERM then SIGKILL after `timeoutSec`). */
  stop(id: string, opts?: { timeoutSec?: number }): Promise<void>;

  /** Remove a container (force kills if running). */
  remove(id: string, opts?: { force?: boolean }): Promise<void>;

  /** List containers, optionally filtered by label(s) (`key` or `key=value`). */
  list(opts?: { label?: string | string[]; all?: boolean }): Promise<ContainerInfo[]>;

  /** Inspect one container by id or name; null if it doesn't exist. */
  inspect(idOrName: string): Promise<ContainerInfo | null>;
}
