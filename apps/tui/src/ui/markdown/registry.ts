import type React from 'react'

export type FencedBlockView = {
  readonly node: React.ReactNode
  readonly columns: number
  readonly rows: number
  readonly numbered?: boolean
}

export type FencedRenderArgs = {
  readonly source: string
  readonly language: string
  readonly width: number
  readonly streaming: boolean
  readonly wrap: boolean
}

export type FencedRenderer = {
  readonly name: string
  readonly handles: (language: string) => boolean
  readonly render: (args: FencedRenderArgs) => FencedBlockView
}

const renderers: FencedRenderer[] = []
let fallback: FencedRenderer | null = null

export function registerFencedRenderer(renderer: FencedRenderer): void {
  renderers.push(renderer)
}

export function registerFallbackRenderer(renderer: FencedRenderer): void {
  fallback = renderer
}

export function rendererFor(language: string): FencedRenderer {
  const claimed = renderers.find((renderer) => renderer.handles(language))
  if (claimed) return claimed
  if (!fallback) throw new Error('no fallback fenced renderer registered')
  return fallback
}

export function resetFencedRenderers(): void {
  renderers.length = 0
  fallback = null
}
