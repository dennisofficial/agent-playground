import { describe, expect, it } from 'bun:test'

import { PromptFragment } from '@dltech/atlas-core'

import {
  createIsolatedContainer,
  portToken,
  resolveSet,
  type DependencyContainer,
} from '../../container/injection'
import { InMemoryPromptRegistry, PromptRegistry } from '../registry'
import { SayingFragment, contextFor } from './fake-fragments'

class FirstFragment extends SayingFragment {
  constructor() {
    super('first', 'first')
  }
}

class SecondFragment extends SayingFragment {
  constructor() {
    super('second', 'second')
  }
}

class ThirdFragment extends SayingFragment {
  constructor() {
    super('third', 'third')
  }
}

const containerHolding = (
  fragments: readonly (new () => PromptFragment)[],
): DependencyContainer => {
  const container = createIsolatedContainer()
  for (const fragment of fragments) {
    container.register(portToken(PromptFragment), { useClass: fragment })
  }
  container.register(portToken(PromptRegistry), { useClass: InMemoryPromptRegistry })
  return container
}

const CONTEXT = contextFor({ modelId: 'claude-opus-5' })

describe('prompt fragments resolved from the container', () => {
  it('resolves every fragment against the one token, in registration order', () => {
    const container = containerHolding([FirstFragment, SecondFragment, ThirdFragment])

    const fragments = resolveSet({ container, token: portToken(PromptFragment) })

    expect(fragments.map((fragment) => fragment.id)).toEqual(['first', 'second', 'third'])
  })

  it('keeps registration order through the registry, so the file reads as the prompt', () => {
    const container = containerHolding([ThirdFragment, FirstFragment, SecondFragment])

    const registry = container.resolve(portToken(PromptRegistry))

    expect(registry.compile(CONTEXT).blocks).toEqual([{ text: 'third\n\nfirst\n\nsecond' }])
  })

  it('shadows the fragments of a parent container rather than merging and reordering them', () => {
    const parent = containerHolding([FirstFragment, SecondFragment])
    const child = parent.createChildContainer()
    child.register(portToken(PromptFragment), { useClass: ThirdFragment })

    const registry = child.resolve(portToken(PromptRegistry))

    expect(registry.compile(CONTEXT).blocks).toEqual([{ text: 'third' }])
  })
})
