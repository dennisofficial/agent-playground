import { describe, expect, it } from "vitest";
import { autoPillView, composeMode } from "./auto-approve-mode";

describe("composeMode", () => {
  it("maps the two switches to the wire mode", () => {
    expect(composeMode(false, false)).toBe("off");
    expect(composeMode(true, false)).toBe("plan");
    expect(composeMode(false, true)).toBe("ship");
    expect(composeMode(true, true)).toBe("both");
  });
});

describe("autoPillView", () => {
  it("reads off as the quiet grey Auto pill", () => {
    expect(autoPillView("off")).toEqual({ tone: "off", label: "Auto" });
  });

  it("reads plan-only as the amber Plan pill", () => {
    expect(autoPillView("plan")).toEqual({ tone: "partial", label: "Plan" });
  });

  it("reads ship-only as the amber Ship pill", () => {
    expect(autoPillView("ship")).toEqual({ tone: "partial", label: "Ship" });
  });

  it("reads both as the full green Auto pill", () => {
    expect(autoPillView("both")).toEqual({ tone: "full", label: "Auto" });
  });
});
