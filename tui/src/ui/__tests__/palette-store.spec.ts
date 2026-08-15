import { afterEach, describe, expect, it } from "bun:test";
import { theme } from "../palette.js";
import {
  applyPalette,
  onPaletteChange,
  paletteVersion,
  resetPalette,
  subscribePalette,
} from "../palette-store.js";

afterEach(() => {
  resetPalette();
});

describe("palette store", () => {
  it("mutates the palette in place, so the ~60 import sites keep their reference", () => {
    // The whole reason for a mutable singleton over a Context: `import { theme }` at module scope
    // must keep seeing the current value without any call site changing.
    const before = theme;
    applyPalette({ accent: "#00ff00" });
    expect(theme).toBe(before);
    expect(theme.accent).toBe("#00ff00");
  });

  it("merges a partial rather than replacing the object", () => {
    applyPalette({ accent: "#00ff00" });
    expect(theme.dim).toBe("gray");
    expect(theme.court.yours).toBe("#e3b341");
  });

  it("replaces nested groups wholesale when given one", () => {
    applyPalette({ court: { agent: "#111111", yours: "#222222", external: "#333333", none: "#444444" } });
    expect(theme.court.agent).toBe("#111111");
    expect(theme.court.none).toBe("#444444");
  });

  it("bumps a version on every apply", () => {
    const before = paletteVersion();
    applyPalette({ accent: "#00ff00" });
    expect(paletteVersion()).toBe(before + 1);
    applyPalette({ dim: "white" });
    expect(paletteVersion()).toBe(before + 2);
  });

  it("notifies subscribers, and stops once unsubscribed", () => {
    let calls = 0;
    const unsubscribe = subscribePalette(() => {
      calls += 1;
    });
    applyPalette({ accent: "#00ff00" });
    expect(calls).toBe(1);
    unsubscribe();
    applyPalette({ accent: "#0000ff" });
    expect(calls).toBe(1);
  });

  it("hands useSyncExternalStore a stable subscribe and a value snapshot", () => {
    // getSnapshot returning a fresh object every call is an infinite render loop, and it does not
    // look like one — see the identity note on `turn-lanes.ts`. A number can only be === itself.
    expect(subscribePalette).toBe(subscribePalette);
    expect(paletteVersion()).toBe(paletteVersion());
  });

  it("clears registered caches BEFORE it notifies renderers", () => {
    // Ordering is the whole correctness argument. A React re-render that runs before the caches are
    // thrown away repaints from the stale ones, so the frame after an edit shows the old colour and
    // the frame after THAT shows the new one — which reads as a laggy editor, not a broken cache.
    const order: string[] = [];
    onPaletteChange(() => order.push("invalidate"));
    subscribePalette(() => order.push("render"));
    applyPalette({ accent: "#00ff00" });
    expect(order).toEqual(["invalidate", "render"]);
  });

  it("runs every registered invalidator, not just the first", () => {
    let cleared = 0;
    onPaletteChange(() => {
      cleared += 1;
    });
    onPaletteChange(() => {
      cleared += 1;
    });
    applyPalette({ accent: "#00ff00" });
    expect(cleared).toBe(2);
  });

  it("restores the shipped palette on reset, so one test cannot colour the next", () => {
    applyPalette({ accent: "#00ff00", dim: "white" });
    resetPalette();
    expect(theme.accent).toBe("#d97757");
    expect(theme.dim).toBe("gray");
  });
});
