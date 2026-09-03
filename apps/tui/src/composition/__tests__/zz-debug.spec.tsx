import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('debug-thread')

it('dumps settings navigation', async () => {
  const app = fakeApp({ model: scriptedModelPort({ script: { thinking: 't', reply: 'done' } }) })
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }} />,
    { width: 150, height: 40 },
  )
  await setup.flush()
  await settle(250)
  await setup.flush()

  setup.mockInput.pressKey('o', { ctrl: true })
  await settle(60)
  await setup.flush()
  console.log('=== frame after ctrl+o ===')
  console.log(setup.captureCharFrame())

  for (let i = 0; i < 14; i += 1) {
    setup.mockInput.pressArrow('down')
    await settle(60)
    await setup.flush()
    const frame = setup.captureCharFrame()
    const cursor = frame.split('\n').find((line) => line.includes('❯'))
    console.log(`down ${i + 1}: ${cursor?.trim() ?? 'NO CURSOR VISIBLE'}`)
  }
}, 60_000)
