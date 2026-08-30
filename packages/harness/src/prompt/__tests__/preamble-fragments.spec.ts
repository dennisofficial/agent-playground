import { describe, expect, it } from 'bun:test'

import {
  EPromptAgent,
  PromptFragment,
  deadFragmentIds,
  modelEntry,
  reachablePromptContexts,
  type CompiledPrompt,
  type PromptContext,
} from '@dltech/atlas-core'

import {
  createIsolatedContainer,
  portToken,
  resolveSet,
  type DependencyContainer,
} from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { registerBuiltinPromptFragments } from '../register-prompt-fragments'
import { InMemoryPromptRegistry, PromptRegistry } from '../registry'

const ROOT = '/Users/dev/project'

const MINIMAL_PREAMBLE = [
  'You are Atlas, a coding agent talking to a developer in their terminal.',
  'Answer directly and concisely, and prefer using a tool over describing what you would do.',
  'This conversation is compacted when it grows long: the earlier turns are replaced by a summary',
  'and you will not be able to read them again. Write anything you will need later into your own',
  'output or into a file, rather than relying on scrolling back.',
].join('\n')

const PROJECT_DIRECTORY =
  `The project directory is ${ROOT}, and it is where a bash command starts.` +
  ' Keep it there: reach elsewhere with absolute paths rather than cd, unless the developer asks you to move.'

const RELATIVE_PATHS =
  'A path you pass to a tool resolves against the project directory, so write those relative to it.' +
  ' A path inside a bash command is resolved by the shell instead, so write those absolute.'

const CONTEXT: PromptContext = {
  agent: EPromptAgent.Main,
  provider: { id: 'anthropic-oauth', modelId: 'claude-opus-5' },
  model: modelEntry('claude-opus-5'),
}

const registeredRootless = (): DependencyContainer => {
  const container = createIsolatedContainer()
  registerBuiltinPromptFragments({ container })
  return container
}

const registered = (root: string = ROOT): DependencyContainer => {
  const container = registeredRootless()
  container.register(WorkspaceRoot, { useValue: root })
  return container
}

const compiled = (root?: string): CompiledPrompt =>
  registered(root).resolve(portToken(PromptRegistry)).compile(CONTEXT)

const prose = (root?: string): string =>
  compiled(root)
    .parts.map((part) => part.text)
    .join('\n')

describe('the ported prose, pinned byte for byte against the preamble it replaces', () => {
  it('reproduces every line of the deleted MINIMAL_PREAMBLE, in order, unchanged', () => {
    expect(prose()).toStartWith(`${MINIMAL_PREAMBLE}\n`)
  })

  it('carries the identity lines as one fragment', () => {
    expect(compiled().parts[0]?.text).toBe(MINIMAL_PREAMBLE.split('\n').slice(0, 2).join('\n'))
  })

  it('carries the compaction lines as one fragment', () => {
    expect(compiled().parts[1]?.text).toBe(MINIMAL_PREAMBLE.split('\n').slice(2).join('\n'))
  })

  it('holds exactly those four fragments and no fifth', () => {
    expect(prose()).toBe(`${MINIMAL_PREAMBLE}\n${PROJECT_DIRECTORY}\n${RELATIVE_PATHS}`)
  })
})

describe('the project-directory sentence, split at the static/live seam', () => {
  it('states the project directory, which is fixed for the session', () => {
    expect(compiled().parts[2]?.text).toStartWith(`The project directory is ${ROOT},`)
  })

  it('tells the model to hold the directory still rather than to steer it', () => {
    expect(compiled().parts[2]?.text).toEndWith(
      'unless the developer asks you to move.',
    )
  })

  it('reads the root it was given rather than a hard-coded one', () => {
    expect(prose('/tmp/elsewhere')).toContain('The project directory is /tmp/elsewhere,')
  })

  it('names no current session directory, which the conversation owns', () => {
    expect(prose()).not.toContain('You are currently in')
    expect(prose()).not.toContain('and you are in it')
  })

  it('is separate from the relative-path rule, which needs no bound root', () => {
    expect(compiled().parts.map((part) => part.id)).toContain('environment.relative-paths')
    expect(compiled().parts[3]?.text).toBe(RELATIVE_PATHS)
  })
})

describe('the sentence that was deliberately not ported', () => {
  it('names no tool, since the tool-name sentence duplicates the tool declarations', () => {
    expect(prose()).not.toContain('Tools available')
  })
})

describe('what the fragments actually emit', () => {
  it('separates the four fragments with a blank line inside the one block', () => {
    expect(compiled().blocks).toEqual([
      {
        text: `You are Atlas, a coding agent talking to a developer in their terminal.
Answer directly and concisely, and prefer using a tool over describing what you would do.

This conversation is compacted when it grows long: the earlier turns are replaced by a summary
and you will not be able to read them again. Write anything you will need later into your own
output or into a file, rather than relying on scrolling back.

The project directory is /Users/dev/project, and it is where a bash command starts. Keep it there: reach elsewhere with absolute paths rather than cd, unless the developer asks you to move.

A path you pass to a tool resolves against the project directory, so write those relative to it. A path inside a bash command is resolved by the shell instead, so write those absolute.`,
      },
    ])
  })

  it('measures each fragment so the compile reads as a budget', () => {
    expect(compiled().parts.map((part) => part.chars)).toEqual(
      compiled().parts.map((part) => part.text.length),
    )
  })

  it('skips nothing, since none of the ported prose is conditional', () => {
    expect(compiled().skipped).toEqual([])
  })
})

describe('the registration file as the table of contents', () => {
  const fragments = (): readonly PromptFragment[] =>
    resolveSet({ container: registered(), token: portToken(PromptFragment) })

  it('lists the fragments in prompt order', () => {
    expect(fragments().map((fragment) => fragment.id)).toEqual([
      'identity.atlas',
      'workflow.compaction-notice',
      'environment.project-directory',
      'environment.relative-paths',
    ])
  })

  it('binds the registry alongside them', () => {
    expect(registered().resolve(portToken(PromptRegistry))).toBeInstanceOf(InMemoryPromptRegistry)
  })

  it('refuses to construct the project-directory fragment when no root is bound', () => {
    expect(() => registeredRootless().resolve(portToken(PromptRegistry))).toThrow(/WorkspaceRoot/)
  })

  it('holds no prose that no reachable context can select', () => {
    expect(
      deadFragmentIds({
        fragments: fragments(),
        contexts: reachablePromptContexts({
          agents: Object.values(EPromptAgent),
          providerIds: ['anthropic-oauth'],
        }),
      }),
    ).toEqual([])
  })
})

describe('the registry is one instance per container, so its memo is not incidental', () => {
  it('hands back the same registry however many times it is resolved', () => {
    const container = createIsolatedContainer()
    registerBuiltinPromptFragments({ container })
    container.register(WorkspaceRoot, { useValue: ROOT })

    const first = container.resolve(portToken(PromptRegistry))
    const second = container.resolve(portToken(PromptRegistry))

    expect(first).toBe(second)
  })
})
