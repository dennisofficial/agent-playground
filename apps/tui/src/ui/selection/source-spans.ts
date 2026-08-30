import type { Renderable } from '@opentui/core'

export type SourceSpan = { readonly holder: Renderable; readonly source: string }

const sources = new WeakMap<Renderable, string>()

export function registerSource(args: { renderable: Renderable; source: string }): void {
  if (args.source.trim().length === 0) {
    sources.delete(args.renderable)
    return
  }
  sources.set(args.renderable, args.source)
}

export function forgetSource(renderable: Renderable): void {
  sources.delete(renderable)
}

export function sourceSpanOf(renderable: Renderable): SourceSpan | null {
  let node: Renderable | null = renderable
  while (node !== null) {
    const source = sources.get(node)
    if (source !== undefined) return { holder: node, source }
    node = node.parent
  }
  return null
}
