import { describe, expect, test } from 'bun:test'

import { createIsolatedContainer, portToken, resolveSet } from '../injection'

abstract class Widget {
  abstract readonly name: string
}

class RedWidget implements Widget {
  readonly name = 'red'
}

describe('resolveSet', () => {
  test('an unregistered class token resolves to an empty set, not a phantom instance', () => {
    const container = createIsolatedContainer()

    expect(resolveSet({ container, token: portToken(Widget) })).toEqual([])
  })

  test('tsyringe resolveAll alone yields the phantom this guards against', () => {
    const container = createIsolatedContainer()

    expect(container.resolveAll(portToken(Widget))).toHaveLength(1)
  })

  test('registered members resolve in registration order', () => {
    const container = createIsolatedContainer()
    container.register(portToken(Widget), { useClass: RedWidget })

    expect(resolveSet({ container, token: portToken(Widget) }).map((w) => w.name)).toEqual(['red'])
  })
})
