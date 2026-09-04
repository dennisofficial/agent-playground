import { describe, expect, it } from 'bun:test'

import { EExecutionLocation } from '../../execution/location'
import { assemble } from '../assemble'
import { defaultRules } from '../pipeline'
import {
  executionLocationNote,
  type ExecutionEnvironment,
} from '../rules/execution-location-block'
import { EMPTY_PROMPT } from '../rules/system-prompt'
import { contextFor, log } from './log-fixture'

const exchange = () =>
  log([
    { type: 'user-said', text: 'hello' },
    { type: 'assistant-said', parts: [{ type: 'text', text: 'hi there' }] },
  ])

const rulesFor = (environment: () => ExecutionEnvironment) =>
  defaultRules({
    prompt: () => EMPTY_PROMPT,
    launchDirectory: '/w',
    executionLocation: () => environment(),
  })

const tailTextOf = (assembled: { messages: readonly { message: unknown }[] }): string => {
  const last = assembled.messages.at(-1)?.message as
    | { content: readonly { type: string; text?: string }[] }
    | undefined
  return last?.content.find((part) => part.type === 'text')?.text ?? ''
}

describe('the execution location block', () => {
  it('says nothing on the host, where a read behaves exactly as it looks', () => {
    const { assembled, trace } = assemble({
      rules: rulesFor(() => ({ location: EExecutionLocation.Host, mounts: [] })),
      ctx: contextFor({ events: exchange() }),
    })

    expect(assembled.messages).toHaveLength(2)
    expect(trace.map((step) => step.name)).toContain('executionLocationBlock')
  })

  it('rides the message tail in a container, naming where the session executes', () => {
    const { assembled } = assemble({
      rules: rulesFor(() => ({ location: EExecutionLocation.Docker, mounts: [] })),
      ctx: contextFor({ events: exchange() }),
    })

    expect(assembled.messages).toHaveLength(3)
    expect(tailTextOf(assembled)).toContain('Docker container')
  })

  it('warns that an unmounted path will fail, the one thing the model cannot see coming', () => {
    const { assembled } = assemble({
      rules: rulesFor(() => ({ location: EExecutionLocation.Docker, mounts: [] })),
      ctx: contextFor({ events: exchange() }),
    })

    expect(tailTextOf(assembled)).toContain('not mounted')
  })

  it('lists what is mounted when the configuration names mounts', () => {
    const { assembled } = assemble({
      rules: rulesFor(() => ({
        location: EExecutionLocation.Docker,
        mounts: ['/var/lib/postgres'],
      })),
      ctx: contextFor({ events: exchange() }),
    })

    expect(tailTextOf(assembled)).toContain('/var/lib/postgres')
    expect(tailTextOf(assembled)).toContain('not mounted')
  })

  it('reflects the switch the moment it happens, because it derives from the column', () => {
    let environment: ExecutionEnvironment = { location: EExecutionLocation.Docker, mounts: [] }
    const rules = rulesFor(() => environment)
    const ctx = contextFor({ events: exchange() })

    environment = { location: EExecutionLocation.Host, mounts: [] }
    const { assembled } = assemble({ rules, ctx })

    expect(assembled.messages).toHaveLength(2)
  })

  it('leaves an empty transcript without a dangling tail', () => {
    const { assembled } = assemble({
      rules: rulesFor(() => ({ location: EExecutionLocation.Docker, mounts: [] })),
      ctx: contextFor({ events: log([]) }),
    })

    expect(assembled.messages).toHaveLength(0)
  })
})

describe('the execution location note', () => {
  it('has nothing to say on the host', () => {
    expect(
      executionLocationNote({ location: EExecutionLocation.Host, mounts: [] }),
    ).toBeUndefined()
  })
})
