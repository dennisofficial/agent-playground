#!/usr/bin/env bun
/**
 * PROTOTYPE (throwaway): shimmer cost variants for the working line.
 *
 * Interactive:  bun apps/tui/scripts/proto-shimmer.tsx
 *   tab — next variant · shift+tab — back · 1/2/3 — tick cadence 40/80/120 ms · q — quit
 *   The stat line shows CPU% and ms/frame measured over the last two seconds.
 *
 * Headless:     NODE_ENV=production bun apps/tui/scripts/proto-shimmer.tsx --bench
 *   Mounts each variant behind six diff panels, idles four seconds, prints a table.
 */
import { createCliRenderer, StyledText, TextNodeRenderable, TextRenderable, type TextChunk, RGBA } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, useKeyboard, useRenderer } from '@opentui/react'
import React, { useEffect, useRef, useState } from 'react'

import { EDetail } from '../src/store/tools'
import { NOT_EXPANDABLE } from '../src/ui/components/blocks/more-toggle'
import { ToolDetail } from '../src/ui/components/blocks/tool-detail'
import { mixHex } from '../src/ui/colour'
import { grammarsReady } from '../src/ui/markdown/__tests__/harness'
import { WORKING_SHIMMER, beaconHeat, shimmerCrest, shimmerCycleMs } from '../src/ui/shimmer'
import { spinnerFrame, theme } from '../src/ui/theme'

const LABEL = 'Thinking for 12s (↓ 1.2k tokens · esc to interrupt)'

type Cadence = 40 | 80 | 120

const CADENCES: readonly Cadence[] = [40, 80, 120]

const ticker = (ms: number, run: (now: number) => void): (() => void) => {
  const timer = setInterval(() => run(Date.now()), ms)
  return () => clearInterval(timer)
}

const rgbaCache = new Map<string, RGBA>()
const rgbaOf = (hex: string): RGBA => {
  const held = rgbaCache.get(hex)
  if (held !== undefined) return held
  const parsed = RGBA.fromHex(hex)
  rgbaCache.set(hex, parsed)
  return parsed
}

const channelCache = new Map<string, [number, number, number]>()
const mixedCache = new Map<string, string>()
const mixed = (from: string, to: string, t: number): string => {
  const amount = Math.round(t * 255) / 255
  const key = `${from}${to}${amount}`
  const held = mixedCache.get(key)
  if (held !== undefined) return held
  const next = mixHex({ from, to, amount })
  mixedCache.set(key, next)
  return next
}

const SHIMMER_CREST = '#f6efe9'

function shimmerChunks(args: { now: number; base: string | undefined }): TextChunk[] {
  const cells = [...LABEL].length + 2
  const crest = shimmerCrest({ nowMs: args.now, cells, spec: WORKING_SHIMMER })
  const base = args.base ?? theme.accent
  const chunks: TextChunk[] = [
    { __isChunk: true, text: spinnerFrame(args.now), fg: rgbaOf(mixed(base, SHIMMER_CREST, beaconHeat({ crest, spec: WORKING_SHIMMER }))) },
    { __isChunk: true, text: ' ' },
  ]
  let lastFg: RGBA | undefined
  let text = ''
  for (const [index, character] of [...LABEL].entries()) {
    const heat = Math.max(0, 1 - Math.abs(index + 2 - crest) / WORKING_SHIMMER.crestWidth)
    const fg = rgbaOf(mixed(base, SHIMMER_CREST, heat))
    if (lastFg === fg) {
      text += character
      continue
    }
    if (text.length > 0 && lastFg !== undefined) chunks.push({ __isChunk: true, text, fg: lastFg })
    if (text.length > 0 && lastFg === undefined) chunks.push({ __isChunk: true, text })
    lastFg = fg
    text = character
  }
  if (text.length > 0) chunks.push(lastFg === undefined ? { __isChunk: true, text } : { __isChunk: true, text, fg: lastFg })
  return chunks
}

function cycleFrames(args: { cadence: Cadence; base?: string }): StyledText[] {
  const cells = [...LABEL].length + 2
  const cycle = shimmerCycleMs({ cells, spec: WORKING_SHIMMER })
  const count = Math.max(1, Math.round(cycle / args.cadence))
  return Array.from({ length: count }, (_u, i) => new StyledText(shimmerChunks({ now: i * args.cadence, base: args.base })))
}

// --- variant: react-spans (the current implementation, verbatim shape) ---

import { shimmerSpans } from '../src/ui/shimmer-style'

function ReactSpansLine(props: { cadence: Cadence }): React.ReactNode {
  const [now, setNow] = useState(Date.now())
  useEffect(() => ticker(props.cadence, setNow), [props.cadence])
  const cells = [...LABEL].length + 2
  const crest = shimmerCrest({ nowMs: now, cells, spec: WORKING_SHIMMER })
  return (
    <text>
      <span fg={mixHex({ from: theme.accent, to: SHIMMER_CREST, amount: beaconHeat({ crest, spec: WORKING_SHIMMER }) })}>
        {spinnerFrame(now)}
      </span>
      <span> </span>
      {shimmerSpans({ text: LABEL, crest, spec: WORKING_SHIMMER, offset: 2 }).map((span, i) => (
        <span key={i} {...(span.fg === undefined ? {} : { fg: span.fg })}>
          {span.text}
        </span>
      ))}
    </text>
  )
}

// --- variant: imperative (ref write per tick, cached colours) ---

type TextRef = React.MutableRefObject<TextRenderable | null>

function imperativeTick(ref: TextRef, now: number, base: string | undefined): void {
  const node = ref.current
  if (node === null) return
  node.content = new StyledText(shimmerChunks({ now, base }))
}

function ImperativeLine(props: { cadence: Cadence }): React.ReactNode {
  const ref = useRef<TextRenderable>(null)
  useEffect(() => ticker(props.cadence, (now) => imperativeTick(ref, now, undefined)), [props.cadence])
  return <text ref={ref} content={new StyledText(shimmerChunks({ now: Date.now(), base: undefined }))} />
}

// --- variant: precomputed frames (one array index per tick) ---

function PrecomputedLine(props: { cadence: Cadence }): React.ReactNode {
  const ref = useRef<TextRenderable>(null)
  const [frames] = useState(() => cycleFrames({ cadence: props.cadence }))
  useEffect(
    () =>
      ticker(props.cadence, (now) => {
        const node = ref.current
        if (node === null) return
        const frame = frames[Math.floor(now / props.cadence) % frames.length]
        if (frame !== undefined) node.content = frame
      }),
    [props.cadence, frames],
  )
  return <text ref={ref} content={frames[0] as StyledText} />
}

// --- variant: spinner only (one TextNode child set per tick) ---

function SpinnerOnlyLine(props: { cadence: Cadence }): React.ReactNode {
  const ref = useRef<TextNodeRenderable>(null)
  useEffect(
    () =>
      ticker(props.cadence, (now) => {
        const spinner = ref.current
        if (spinner === null) return
        spinner.children = [TextNodeRenderable.fromString(spinnerFrame(now), { fg: theme.accent })]
      }),
    [props.cadence],
  )
  return (
    <text>
      <span ref={ref} fg={theme.accent}>
        {spinnerFrame(Date.now())}
      </span>
      <span>{` ${LABEL}`}</span>
    </text>
  )
}

// --- variant: pulse (two level swap, no per-character math) ---

const PULSE = [theme.accent, theme.hover]

function PulseLine(props: { cadence: Cadence }): React.ReactNode {
  const ref = useRef<TextRenderable>(null)
  useEffect(
    () =>
      ticker(props.cadence, (now) => {
        const node = ref.current
        if (node === null) return
        const phase = Math.floor(now / 500) % PULSE.length
        node.content = new StyledText([
          { __isChunk: true, text: `${spinnerFrame(now)} ${LABEL}`, fg: rgbaOf(PULSE[phase] ?? theme.accent) },
        ])
      }),
    [props.cadence],
  )
  return <text ref={ref} content={`${spinnerFrame(Date.now())} ${LABEL}`} />
}

type Variant = { name: string; Line: (props: { cadence: Cadence }) => React.ReactNode }

const VARIANTS: readonly Variant[] = [
  { name: 'react-spans (current)', Line: ReactSpansLine },
  { name: 'imperative + cached colours', Line: ImperativeLine },
  { name: 'precomputed frames', Line: PrecomputedLine },
  { name: 'spinner only', Line: SpinnerOnlyLine },
  { name: 'two-level pulse', Line: PulseLine },
]

// --- backdrop: six settled diffs behind the line, the shape measured earlier ---

const EDIT_CALL = {
  callId: 'call-2',
  name: 'edit',
  input: { path: '/tmp/a.ts', oldString: 'a', newString: 'b' },
  output: {
    path: '/tmp/a.ts',
    diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n const x = 1\n-const y = a\n+const y = b\n const z = 3\n',
  },
  settled: true,
  failed: false,
}

const PANELS = 6

function Backdrop(props: { panels: number }): React.ReactNode {
  return (
    <scrollbox flexGrow={1}>
      {Array.from({ length: props.panels }, (_u, i) => (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <ToolDetail key={i} detail={EDetail.Diff} call={EDIT_CALL as any} inner={80} cwd="/tmp" expand={NOT_EXPANDABLE} />
      ))}
    </scrollbox>
  )
}

// --- measurement ---

const measure = async (args: { framesRendered: () => number; ms: number }): Promise<string> => {
  const framesBefore = args.framesRendered()
  const cpuBefore = process.cpuUsage()
  const started = performance.now()
  await new Promise((r) => setTimeout(r, args.ms))
  const wall = performance.now() - started
  const cpu = process.cpuUsage(cpuBefore)
  const frames = args.framesRendered() - framesBefore
  const cpuPct = ((cpu.user + cpu.system) / 1000 / wall) * 100
  const perFrame = (cpu.user + cpu.system) / 1000 / Math.max(1, frames)
  return `${frames} frames (${(frames / (wall / 1000)).toFixed(1)}/s) · ${cpuPct.toFixed(1)}% cpu · ${perFrame.toFixed(2)} ms/frame`
}

// --- interactive ---

function ProbeApp(): React.ReactNode {
  const renderer = useRenderer()
  const [variant, setVariant] = useState(0)
  const [cadence, setCadence] = useState(1)
  const [stats, setStats] = useState('')
  const statsRef = useRef({ frame: 0, cpu: process.cpuUsage(), at: performance.now() })
  const frames = () => renderer.getStats().frameCount

  useEffect(
    () =>
      ticker(2000, () => {
        const now = performance.now()
        const cpu = process.cpuUsage(statsRef.current.cpu)
        const wall = now - statsRef.current.at
        const drawn = frames() - statsRef.current.frame
        statsRef.current = { frame: frames(), cpu: process.cpuUsage(), at: now }
        setStats(
          `${drawn} frames (${(drawn / (wall / 1000)).toFixed(1)}/s) · ${(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(1)}% cpu · ${((cpu.user + cpu.system) / 1000 / Math.max(1, drawn)).toFixed(2)} ms/frame`,
        )
      }),
    [],
  )

  useKeyboard((key) => {
    if (key.name === 'tab') setVariant((v) => (v + (key.shift ? VARIANTS.length - 1 : 1)) % VARIANTS.length)
    if (key.name === '1') setCadence(0)
    if (key.name === '2') setCadence(1)
    if (key.name === '3') setCadence(2)
    if (key.name === 'q') {
      renderer.destroy()
      process.exit(0)
    }
  })

  const picked: Variant = VARIANTS[variant] ?? VARIANTS[0] as Variant
  const rate: Cadence = CADENCES[cadence] ?? 40

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Backdrop panels={PANELS} />
      <picked.Line key={`${variant}-${rate}`} cadence={rate} />
      <text fg={theme.hint}>
        {`▸ ${picked.name} @ ${rate} ms — ${stats}`}
      </text>
      <text fg={theme.dim}>{'tab variant · shift+tab back · 1/2/3 cadence 40/80/120 · q quit'}</text>
    </box>
  )
}

// --- headless ---

const bench = async (): Promise<void> => {
  const rows: string[] = []
  for (const variant of VARIANTS) {
    for (const cadence of CADENCES) {
      const setup = await createTestRenderer({ width: 150, height: 40 })
      const root = createRoot(setup.renderer)
      root.render(
        <box flexDirection="column" width="100%" height="100%">
          <Backdrop panels={PANELS} />
          <variant.Line cadence={cadence} />
        </box>,
      )
      await new Promise((r) => setTimeout(r, 400))
      rows.push(`${variant.name.padEnd(28)} @ ${String(cadence).padStart(3)} ms — ${await measure({ framesRendered: () => setup.renderer.getStats().frameCount, ms: 4000 })}`)
      setup.renderer.destroy()
    }
  }
  console.log('\nshimmer cost probe')
  for (const row of rows) console.log(`  ${row}`)
}

await grammarsReady()

if (process.argv.includes('--bench')) {
  await bench()
  process.exit(0)
}

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<ProbeApp />)
