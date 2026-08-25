import type React from "react";

export type FencedBlockView = {
  readonly node: React.ReactNode;
  readonly columns: number;
  readonly rows: number;
};

export type FencedRenderer = {
  readonly name: string;
  readonly handles: (language: string) => boolean;
  readonly render: (
    source: string,
    language: string,
    width: number,
  ) => FencedBlockView;
};

const renderers: FencedRenderer[] = [];
let fallback: FencedRenderer | null = null;

export function registerFencedRenderer(renderer: FencedRenderer): void {
  renderers.push(renderer);
}

/** The renderer used when nothing claims the language. Setting it twice replaces it. */
export function registerFallbackRenderer(renderer: FencedRenderer): void {
  fallback = renderer;
}

export function rendererFor(language: string): FencedRenderer {
  const claimed = renderers.find((r) => r.handles(language));
  if (claimed) return claimed;
  if (!fallback) throw new Error("no fallback fenced renderer registered");
  return fallback;
}

/** Test seam — the registry is module state, so a test that registers must be able to undo it. */
export function resetFencedRenderers(): void {
  renderers.length = 0;
  fallback = null;
}
