import { describe, expect, it } from "bun:test";

import { EExecutionLocation } from "@dltech/atlas-core";
import {
  EShellStatus,
  ESandboxState,
  toShellId,
  type ShellSnapshot,
} from "@dltech/atlas-harness";

import {
  containerPillOf,
  exposedPortsOf,
  withContainer,
  IDLE_SIDEBAR,
  type SidebarContainer,
} from "../sidebar-model";

const running: SidebarContainer = {
  state: ESandboxState.Running,
  image: "node:22-slim",
  ports: [
    { containerPort: 3000, hostPort: 20_123 },
    { containerPort: 3001, hostPort: 20_124 },
    { containerPort: 3002, hostPort: 20_125 },
    { containerPort: 3003, hostPort: 20_126 },
  ],
};

const shell = (over: Omit<Partial<ShellSnapshot>, "shellId"> & { shellId: string }): ShellSnapshot =>
  ({
    command: "sleep 60",
    description: "",
    status: EShellStatus.Running,
    startedAt: new Date().toISOString(),
    lastOutputAt: new Date().toISOString(),
    totalCharacters: 0,
    awaitingInput: false,
    ...over,
    shellId: toShellId(over.shellId),
  });

describe("the exposed ports a shell asked for", () => {
  it("collects the exposure of each running shell, cheapest container port first", () => {
    const ports = exposedPortsOf({
      shells: [
        shell({
          shellId: "bash_2",
          exposure: { containerPort: 3001, hostPort: 20_124, url: "http://localhost:20124" },
        }),
        shell({
          shellId: "bash_1",
          exposure: { containerPort: 3000, hostPort: 20_123, url: "http://localhost:20123" },
        }),
      ],
    });

    expect(ports).toEqual([
      { containerPort: 3000, hostPort: 20_123 },
      { containerPort: 3001, hostPort: 20_124 },
    ]);
  });

  it("ignores shells without an exposure and shells whose server already ended", () => {
    const ports = exposedPortsOf({
      shells: [
        shell({ shellId: "bash_1" }),
        shell({
          shellId: "bash_2",
          status: EShellStatus.Exited,
          exitCode: 0,
          exposure: { containerPort: 3000, hostPort: 20_123, url: "http://localhost:20123" },
        }),
      ],
    });

    expect(ports).toEqual([]);
  });
});

describe("the container pill", () => {
  it("is absent on the host, whatever the sandbox is doing", () => {
    expect(
      containerPillOf({ location: EExecutionLocation.Host, container: running, exposed: [] }),
    ).toBeNull();
  });

  it("carries state and image when the conversation runs in docker", () => {
    const pill = containerPillOf({
      location: EExecutionLocation.Docker,
      container: running,
      exposed: [],
    });

    expect(pill).toEqual({
      state: ESandboxState.Running,
      image: "node:22-slim",
      ports: [],
    });
  });

  it("shows only the ports a shell exposed, never the inert published block", () => {
    const pill = containerPillOf({
      location: EExecutionLocation.Docker,
      container: running,
      exposed: [{ containerPort: 3001, hostPort: 20_124 }],
    });

    expect(pill?.ports).toEqual([{ containerPort: 3001, hostPort: 20_124 }]);
  });

  it("derives identical bytes on consecutive reads of a running container", () => {
    const exposed = [{ containerPort: 3000, hostPort: 20_123 }];
    const first = containerPillOf({
      location: EExecutionLocation.Docker,
      container: running,
      exposed,
    });
    const second = containerPillOf({
      location: EExecutionLocation.Docker,
      container: running,
      exposed,
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("carries the daemon's reason when the container failed", () => {
    const failed: SidebarContainer = {
      state: ESandboxState.Failed,
      image: "node:22-slim",
      ports: [],
      reason: "No such image: atlas-dev-no-such-image:latest",
    };

    const pill = containerPillOf({
      location: EExecutionLocation.Docker,
      container: failed,
      exposed: [],
    });

    expect(pill?.state).toBe(ESandboxState.Failed);
    expect(pill?.reason).toBe("No such image: atlas-dev-no-such-image:latest");
  });

  it("joins the sidebar model only when it is shown", () => {
    const shown = withContainer({
      model: IDLE_SIDEBAR,
      container: containerPillOf({
        location: EExecutionLocation.Docker,
        container: running,
        exposed: [],
      }),
    });
    expect(shown.container?.image).toBe("node:22-slim");

    const hidden = withContainer({
      model: IDLE_SIDEBAR,
      container: containerPillOf({
        location: EExecutionLocation.Host,
        container: running,
        exposed: [],
      }),
    });
    expect(hidden.container).toBeUndefined();
  });
});
