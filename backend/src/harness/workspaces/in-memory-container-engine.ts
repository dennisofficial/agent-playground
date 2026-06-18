import type {
  ContainerEnginePort,
  ContainerHandle,
  ContainerSummary,
  CreateContainerSpec,
  ListContainersFilter,
} from './container-engine.port';

/** One created container as the fake tracks it — the verbatim create spec + a state + a synthetic id. */
export interface FakeContainer {
  id: string;
  spec: CreateContainerSpec;
  state: 'created' | 'running' | 'exited' | 'removed';
}

/**
 * A deterministic, dependency-free in-memory `ContainerEnginePort` for UNIT TESTS — the full
 * `ContainerManagerService` create/find/reconcile path runs against this with NO Docker socket.
 *
 * It models the slice of Docker the manager relies on:
 *  - `createContainer` records the spec verbatim (so tests assert privileged/labels/no-ports/env/limits)
 *    and yields a synthetic id; the container starts in 'created';
 *  - `start`/`stop` flip state; `remove` marks 'removed' and drops it from listings;
 *  - `listContainers` honours `all` (running-only vs include-stopped) and `label` filters in the same
 *    `key` / `key=value` match semantics as real Docker (so boot reconciliation is exercised faithfully);
 *  - `inspectContainer` returns the live summary or undefined once removed.
 *
 * Tests can also `seed()` pre-existing containers to simulate a host that already had sandboxes running
 * before boot (the reconciliation scenario), and read `created`/`removed` call logs for assertions.
 */
export class InMemoryContainerEngine implements ContainerEnginePort {
  private readonly containers = new Map<string, FakeContainer>();
  private seq = 0;

  /** Synthetic-id counter exposed so a test can assert "find didn't create a second container". */
  readonly created: CreateContainerSpec[] = [];
  readonly removed: string[] = [];

  /** TEST HELPER: inject a container as if it already existed on the host before this process booted. */
  seed(spec: CreateContainerSpec, state: FakeContainer['state'] = 'running'): string {
    const id = `c-${++this.seq}`;
    this.containers.set(id, { id, spec, state });
    return id;
  }

  createContainer(spec: CreateContainerSpec): Promise<ContainerHandle> {
    const id = `c-${++this.seq}`;
    this.containers.set(id, { id, spec, state: 'created' });
    this.created.push(spec);
    return Promise.resolve({ id, labels: spec.labels });
  }

  startContainer(id: string): Promise<void> {
    const c = this.containers.get(id);
    if (c && c.state !== 'removed') c.state = 'running';
    return Promise.resolve();
  }

  stopContainer(id: string): Promise<void> {
    const c = this.containers.get(id);
    if (c && c.state !== 'removed') c.state = 'exited';
    return Promise.resolve();
  }

  removeContainer(id: string): Promise<void> {
    const c = this.containers.get(id);
    if (c) c.state = 'removed';
    this.removed.push(id);
    this.containers.delete(id);
    return Promise.resolve();
  }

  listContainers(filter?: ListContainersFilter): Promise<ContainerSummary[]> {
    const all = filter?.all ?? false;
    const wanted = filter?.label ?? [];
    const out: ContainerSummary[] = [];
    for (const c of this.containers.values()) {
      if (c.state === 'removed') continue;
      if (!all && c.state !== 'running') continue;
      if (!wanted.every((w) => matchesLabel(c.spec.labels, w))) continue;
      out.push(this.summary(c));
    }
    return Promise.resolve(out);
  }

  inspectContainer(id: string): Promise<ContainerSummary | undefined> {
    const c = this.containers.get(id);
    return Promise.resolve(c ? this.summary(c) : undefined);
  }

  private summary(c: FakeContainer): ContainerSummary {
    return {
      id: c.id,
      names: [`/${c.spec.name}`],
      labels: { ...c.spec.labels },
      state: c.state,
    };
  }
}

/** Match a `key` (presence) or `key=value` (exact) label filter the way Docker's label filter does. */
function matchesLabel(labels: Record<string, string>, filter: string): boolean {
  const eq = filter.indexOf('=');
  if (eq === -1) return filter in labels;
  const key = filter.slice(0, eq);
  const value = filter.slice(eq + 1);
  return labels[key] === value;
}
