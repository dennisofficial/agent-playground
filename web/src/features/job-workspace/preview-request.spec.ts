import { describe, expect, it } from "vitest";
import { canOfferPreview, PREVIEW_REQUEST_TEXT } from "./preview-request";

describe("canOfferPreview", () => {
  it("offers the preview for build-brain kinds once the sandbox branch is cut", () => {
    expect(canOfferPreview("feat", "atlas/feature-x")).toBe(true);
    expect(canOfferPreview("fix", "atlas/bug-y")).toBe(true);
    expect(canOfferPreview("event", "atlas/evt-z")).toBe(true);
  });

  it("never offers on non-build brains (onboarding / external-PR review)", () => {
    expect(canOfferPreview("onboard", "atlas/anything")).toBe(false);
    expect(canOfferPreview("review", "atlas/anything")).toBe(false);
  });

  it("hides the button until a sandbox/branch exists", () => {
    expect(canOfferPreview("feat", null)).toBe(false);
    expect(canOfferPreview("feat", undefined)).toBe(false);
    expect(canOfferPreview("feat", "")).toBe(false);
  });
});

describe("PREVIEW_REQUEST_TEXT", () => {
  it("asks for a demo-ready live preview with a link and login", () => {
    expect(PREVIEW_REQUEST_TEXT).toMatch(/live preview/i);
    expect(PREVIEW_REQUEST_TEXT).toMatch(/demo-ready/i);
  });
});
