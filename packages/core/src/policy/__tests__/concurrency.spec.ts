import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { EToolEffect, type ToolDeclaration } from '../../tools/tool'
import { isConcurrencySafeCall, partitionToolCalls } from '../concurrency'

const declaring = (args: {
  name?: string
  effect?: EToolEffect
  inputSchema?: z.ZodType
  isConcurrencySafe?: ((input: unknown) => boolean) | undefined
}): ToolDeclaration => ({
  name: args.name ?? 'read',
  description: 'a tool',
  effect: args.effect ?? EToolEffect.Read,
  inputSchema: args.inputSchema ?? z.strictObject({ path: z.string() }),
  ...(args.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: args.isConcurrencySafe }),
})

describe('deciding whether one call may share a batch', () => {
  it('is safe when a read tool says so of its own input', () => {
    const declaration = declaring({ isConcurrencySafe: () => true })

    expect(isConcurrencySafeCall({ declaration, input: { path: 'a.ts' } })).toBe(true)
  })

  it('hands the predicate the parsed input rather than the raw call', () => {
    const seen: unknown[] = []
    const declaration = declaring({
      inputSchema: z.strictObject({ path: z.string(), depth: z.coerce.number().default(3) }),
      isConcurrencySafe: (input) => {
        seen.push(input)
        return true
      },
    })

    isConcurrencySafeCall({ declaration, input: { path: 'a.ts' } })

    expect(seen).toEqual([{ path: 'a.ts', depth: 3 }])
  })

  it('is unsafe when the tool declares no opinion, so an unmarked tool never joins a batch', () => {
    expect(isConcurrencySafeCall({ declaration: declaring({}), input: { path: 'a.ts' } })).toBe(false)
  })

  it('is unsafe when no tool of that name is registered', () => {
    expect(isConcurrencySafeCall({ declaration: undefined, input: {} })).toBe(false)
  })

  it('is unsafe when the input does not match the schema, so a doomed call runs alone', () => {
    const declaration = declaring({ isConcurrencySafe: () => true })

    expect(isConcurrencySafeCall({ declaration, input: { path: 42 } })).toBe(false)
  })

  it('is unsafe when the predicate throws', () => {
    const declaration = declaring({
      isConcurrencySafe: () => {
        throw new Error('no idea')
      },
    })

    expect(isConcurrencySafeCall({ declaration, input: { path: 'a.ts' } })).toBe(false)
  })

  it('is unsafe when the predicate returns something other than true', () => {
    const declaration = declaring({ isConcurrencySafe: () => undefined as unknown as boolean })

    expect(isConcurrencySafeCall({ declaration, input: { path: 'a.ts' } })).toBe(false)
  })

  for (const effect of [EToolEffect.Write, EToolEffect.Destructive]) {
    it(`refuses a ${effect} tool even when it declares itself safe, because its snapshot must mean "before this call"`, () => {
      const declaration = declaring({ effect, isConcurrencySafe: () => true })

      expect(isConcurrencySafeCall({ declaration, input: { path: 'a.ts' } })).toBe(false)
    })
  }
})

type Named = { name: string; safe: boolean }

const named = (name: string, safe: boolean): Named => ({ name, safe })

const shapeOf = (runs: readonly (readonly Named[])[]): string[][] =>
  runs.map((run) => run.map((call) => call.name))

const partition = (calls: readonly Named[]): string[][] =>
  shapeOf(partitionToolCalls({ calls, isSafe: (call) => call.safe }))

describe('folding a step of calls into runs that may go at once', () => {
  it('gathers consecutive safe calls into one run', () => {
    expect(partition([named('a', true), named('b', true), named('c', true)])).toEqual([['a', 'b', 'c']])
  })

  it('gives every unsafe call a run of its own', () => {
    expect(partition([named('a', false), named('b', false)])).toEqual([['a'], ['b']])
  })

  it('splits a batch at an unsafe call, so the unsafe one is a barrier', () => {
    const calls = [
      named('read-1', true),
      named('read-2', true),
      named('write', false),
      named('read-3', true),
    ]

    expect(partition(calls)).toEqual([['read-1', 'read-2'], ['write'], ['read-3']])
  })

  it('does not rejoin safe calls across a barrier', () => {
    const calls = [named('a', true), named('bash', false), named('b', true), named('c', true)]

    expect(partition(calls)).toEqual([['a'], ['bash'], ['b', 'c']])
  })

  it('never caps a run, however many safe calls a step emits', () => {
    const calls = Array.from({ length: 40 }, (_, index) => named(`read-${index}`, true))

    const runs = partition(calls)

    expect(runs).toHaveLength(1)
    expect(runs[0]).toHaveLength(40)
  })

  it('preserves order across every run, so the log still reads in call order', () => {
    const calls = [named('a', true), named('b', false), named('c', true), named('d', true)]

    expect(partition(calls).flat()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns nothing for no calls', () => {
    expect(partition([])).toEqual([])
  })

  it('treats a throwing predicate as unsafe rather than failing the step', () => {
    const runs = partitionToolCalls({
      calls: [named('a', true), named('boom', true)],
      isSafe: (call) => {
        if (call.name === 'boom') throw new Error('no idea')
        return true
      },
    })

    expect(shapeOf(runs)).toEqual([['a'], ['boom']])
  })
})
