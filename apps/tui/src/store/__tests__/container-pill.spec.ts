import { describe, expect, it } from "bun:test";

import { EExecutionLocation } from "@dltech/atlas-core";
import { ESandboxState } from "@dltech/atlas-harness";

import {
  containerPillOf,
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
  ],
};

describe("the container pill", () => {
  it("is absent on the host, whatever the sandbox is doing", () => {
    expect(containerPillOf({ location: EExecutionLocation.Host, container: running })).toBeNull();
  });

  it("carries state, image and published ports when the conversation runs in docker", () => {
    const pill = containerPillOf({ location: EExecutionLocation.Docker, container: running });

    expect(pill).toEqual({
      state: ESandboxState.Running,
      image: "node:22-slim",
      ports: running.ports,
    });
  });

  it("derives identical bytes on consecutive reads of a running container", () => {
    const first = containerPillOf({ location: EExecutionLocation.Docker, container: running });
    const second = containerPillOf({ location: EExecutionLocation.Docker, container: running });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("carries the daemon's reason when the container failed", () => {
    const failed: SidebarContainer = {
      state: ESandboxState.Failed,
      image: "node:22-slim",
      ports: [],
      reason: "No such image: atlas-dev-no-such-image:latest",
    };

    const pill = containerPillOf({ location: EExecutionLocation.Docker, container: failed });

    expect(pill?.state).toBe(ESandboxState.Failed);
    expect(pill?.reason).toBe("No such image: atlas-dev-no-such-image:latest");
  });

  it("joins the sidebar model only when it is shown", () => {
    const shown = withContainer({
      model: IDLE_SIDEBAR,
      container: containerPillOf({ location: EExecutionLocation.Docker, container: running }),
    });
    expect(shown.container?.image).toBe("node:22-slim");

    const hidden = withContainer({
      model: IDLE_SIDEBAR,
      container: containerPillOf({ location: EExecutionLocation.Host, container: running }),
    });
    expect(hidden.container).toBeUndefined();
  });
});
