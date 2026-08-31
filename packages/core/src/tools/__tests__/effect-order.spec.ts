import { describe, expect, it } from 'bun:test'

import { EToolEffect } from '../tool'
import { TOOL_EFFECTS, permitsEffect, toToolEffect } from '../effect-order'

const permits = (args: { effect: EToolEffect; ceiling: EToolEffect | undefined }): boolean =>
  permitsEffect(args)

describe('permitsEffect', () => {
  it('permits every effect when there is no ceiling', () => {
    for (const effect of TOOL_EFFECTS) {
      expect(permits({ effect, ceiling: undefined })).toBe(true)
    }
  })

  it('permits an effect at the ceiling', () => {
    for (const effect of TOOL_EFFECTS) {
      expect(permits({ effect, ceiling: effect })).toBe(true)
    }
  })

  it('orders read below write below destructive', () => {
    expect(permits({ effect: EToolEffect.Read, ceiling: EToolEffect.Write })).toBe(true)
    expect(permits({ effect: EToolEffect.Write, ceiling: EToolEffect.Destructive })).toBe(true)
    expect(permits({ effect: EToolEffect.Read, ceiling: EToolEffect.Destructive })).toBe(true)
  })

  it('refuses an effect above the ceiling', () => {
    expect(permits({ effect: EToolEffect.Write, ceiling: EToolEffect.Read })).toBe(false)
    expect(permits({ effect: EToolEffect.Destructive, ceiling: EToolEffect.Read })).toBe(false)
    expect(permits({ effect: EToolEffect.Destructive, ceiling: EToolEffect.Write })).toBe(false)
  })

  it('admits a read ceiling only for read', () => {
    const admitted = TOOL_EFFECTS.filter((effect) => permits({ effect, ceiling: EToolEffect.Read }))

    expect(admitted).toEqual([EToolEffect.Read])
  })
})

describe('toToolEffect', () => {
  it('reads back every effect it can write', () => {
    for (const effect of TOOL_EFFECTS) {
      expect(toToolEffect(effect)).toBe(effect)
    }
  })

  it('rejects anything that is not an effect', () => {
    expect(toToolEffect('reed')).toBeUndefined()
    expect(toToolEffect('')).toBeUndefined()
    expect(toToolEffect('READ')).toBeUndefined()
  })
})
