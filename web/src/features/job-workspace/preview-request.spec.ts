import { describe, expect, it } from "vitest";
import { canOfferPreview, PREVIEW_REQUEST_TEXT } from "./preview-request";

describe("canOfferPreview", () => {
  it("offers the preview for build-brain kinds", () => {
    expect(canOfferPreview("feat")).toBe(true);
    expect(canOfferPreview("fix")).toBe(true);
    expect(canOfferPreview("event")).toBe(true);
  });

  it("never offers on non-build brains (onboarding / external-PR review)", () => {
    expect(canOfferPreview("onboard")).toBe(false);
    expect(canOfferPreview("review")).toBe(false);
  });

  it("waits until a job kind is known", () => {
    expect(canOfferPreview(null)).toBe(false);
    expect(canOfferPreview(undefined)).toBe(false);
  });
});

describe("PREVIEW_REQUEST_TEXT", () => {
  it("asks for a demo-ready live preview with a link and login", () => {
    expect(PREVIEW_REQUEST_TEXT).toMatch(/live preview/i);
    expect(PREVIEW_REQUEST_TEXT).toMatch(/demo-ready/i);
  });
});
