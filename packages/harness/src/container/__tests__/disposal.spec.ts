import { describe, expect, it } from 'bun:test'

import { createIsolatedContainer } from '../injection'
import { disposeAll, registerDisposable } from '../disposal'

describe('the disposal registry', () => {
  it('closes in reverse registration order, so a dependency outlives its dependants', async () => {
    const closed: string[] = []
    const container = createIsolatedContainer()

    registerDisposable({ container, close: async () => void closed.push('database') })
    registerDisposable({ container, close: async () => void closed.push('provider-session') })

    await disposeAll({ container })

    expect(closed).toEqual(['provider-session', 'database'])
  })

  it('closes everything even when one disposable throws, then reports the failure', async () => {
    const closed: string[] = []
    const container = createIsolatedContainer()

    registerDisposable({ container, close: async () => void closed.push('database') })
    registerDisposable({
      container,
      close: async () => {
        throw new Error('socket already gone')
      },
    })

    await expect(disposeAll({ container })).rejects.toThrow('teardown failed')
    expect(closed).toEqual(['database'])
  })

  it('is a no-op on a container nobody registered a disposable against', async () => {
    await expect(disposeAll({ container: createIsolatedContainer() })).resolves.toBeUndefined()
  })
})
