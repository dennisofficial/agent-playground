
export const CONTAINER_ENGINE = Symbol('CONTAINER_ENGINE');

export interface VolumeMount {
  name: string;
  path: string;
}

export interface PortMapping {
  containerPort: number;
  hostPort?: number;
  protocol?: 'tcp' | 'udp';
}

export interface CreateContainerSpec {
  name: string;
  image: string;
  network?: string;
  binds?: string[];
  volumes?: VolumeMount[];
  labels?: Record<string, string>;
  env?: Record<string, string>;
  privileged?: boolean;
  cpuShares?: number;
  init?: boolean;
  nanoCpus?: number;
  memoryBytes?: number;
  pidsLimit?: number;
  cmd?: string[];
  workingDir?: string;
  ports?: PortMapping[];
}

export interface ExecOptions {
  user?: string;
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
  onStdinReady?: (write: (data: string) => void, end: () => void) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface DetachedExecOptions {
  user?: string;
  env?: Record<string, string>;
  cwd?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  startedAt: string | null;
}

export interface NetworkInfo {
  id: string;
  name: string;
}

export interface VolumeInfo {
  name: string;
}

export interface BuildImageSpec {
  contextDir: string;
  dockerfile?: string;
  tag: string;
  buildArgs?: Record<string, string>;
  onProgress?: (line: string) => void;
}

export interface ContainerEngine {
  ensureNetwork(name: string): Promise<void>;

  connectNetwork(id: string, network: string): Promise<void>;

  disconnectNetwork(id: string, network: string): Promise<void>;

  imageExists(tag: string): Promise<boolean>;

  imageId(tag: string): Promise<string | null>;

  imageLabels(tag: string): Promise<Record<string, string> | null>;

  buildImage(spec: BuildImageSpec): Promise<void>;

  createContainer(spec: CreateContainerSpec): Promise<string>;

  start(id: string): Promise<void>;

  exec(id: string, argv: string[], opts?: ExecOptions): Promise<ExecResult>;

  execDetached(id: string, argv: string[], opts?: DetachedExecOptions): Promise<{ pid?: number }>;

  stop(id: string, opts?: { timeoutSec?: number }): Promise<void>;

  remove(id: string, opts?: { force?: boolean }): Promise<void>;

  removeNetwork(name: string): Promise<void>;

  removeVolume(name: string): Promise<void>;

  list(opts?: { label?: string | string[]; all?: boolean }): Promise<ContainerInfo[]>;

  systemDf?(): Promise<{
    imagesBytes: number;
    containersBytes: number;
    volumesBytes: number;
    buildCacheBytes: number;
    totalBytes: number;
  }>;

  inspect(idOrName: string): Promise<ContainerInfo | null>;

  listNetworks(): Promise<NetworkInfo[]>;

  listVolumes(): Promise<VolumeInfo[]>;
}
