import { describe, expect, it } from "bun:test";

import { EBuildContext, EImageKind } from "@dltech/atlas-harness";

import { imageLabelOf } from "../container-label";

describe("the container image label", () => {
  it("drops the registry and owner from a full reference, keeping name and tag", () => {
    expect(
      imageLabelOf({
        kind: EImageKind.Image,
        reference: "ghcr.io/dennisofficial/atlas-sandbox:latest",
      }),
    ).toBe("atlas-sandbox:latest");
  });

  it("leaves a bare reference alone", () => {
    expect(imageLabelOf({ kind: EImageKind.Image, reference: "node:22-slim" })).toBe(
      "node:22-slim",
    );
  });

  it("keeps the version tag a pinned release image carries", () => {
    expect(
      imageLabelOf({
        kind: EImageKind.Image,
        reference: "ghcr.io/dennisofficial/atlas-sandbox:1.4.2",
      }),
    ).toBe("atlas-sandbox:1.4.2");
  });

  it("names a custom Dockerfile by its last two path segments", () => {
    expect(
      imageLabelOf({
        kind: EImageKind.Dockerfile,
        path: "/work/project/.atlas/Dockerfile",
        context: EBuildContext.Directory,
      }),
    ).toBe(".atlas/Dockerfile");
  });

  it("still names a Dockerfile that sits at a shallow path", () => {
    expect(
      imageLabelOf({
        kind: EImageKind.Dockerfile,
        path: "Dockerfile",
        context: EBuildContext.DockerfileOnly,
      }),
    ).toBe("Dockerfile");
  });
});
