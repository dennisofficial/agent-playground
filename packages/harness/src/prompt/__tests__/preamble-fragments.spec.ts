import { describe, expect, it } from 'bun:test'

import {
  EPromptAgent,
  ESkipReason,
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
import { SkillRegistryPort } from '../../skills/port'
import { registerBuiltinPromptFragments } from '../register-prompt-fragments'
import { InMemoryPromptRegistry, PromptRegistry } from '../registry'
import { FakeSkillRegistry } from './fake-skills'

const ROOT = '/Users/dev/project'

const MINIMAL_PREAMBLE = [
  'You are Atlas, a coding agent talking to a developer in their terminal.',
  'Answer directly and concisely, and prefer using a tool over describing what you would do.',
  'This conversation is compacted when it grows long: the earlier turns are replaced by a summary',
  'and you will not be able to read them again. Write anything you will need later into your own',
  'output or into a file, rather than relying on scrolling back.',
].join('\n')

const PROJECT_DIRECTORY =
  `The project directory is ${ROOT}, and every bash command starts there.` +
  ' You are already in it, so never spend a cd returning to it, and run somewhere else by passing that directory as workdir rather than by cd.'

const RELATIVE_PATHS =
  'A path you pass to a tool resolves against the project directory, so write those relative to it.' +
  ' A path inside a bash command is resolved by the shell instead, against workdir or the project directory, so write those absolute.'

const READ_BEFORE_WRITE = `write replaces a file whole, so an existing file has to have been read whole before you may
replace it. read gives you that; grep gives you only the lines it matched; reading a file through
the shell gives you nothing that is tracked at all. edit needs no prior read, because its old text
has to match — an unanchored change fails rather than lands.

Every file you have read is watched. If it changes underneath you, the next write or edit to it is
refused until you have read it again.`

const CONTEXT: PromptContext = {
  agent: EPromptAgent.Main,
  provider: { id: 'anthropic-oauth', modelId: 'claude-opus-5' },
  model: modelEntry('claude-opus-5'), projectDirectory: '/w'
}

const registeredRootless = (): DependencyContainer => {
  const container = createIsolatedContainer()
  registerBuiltinPromptFragments({ container })
  container.register(portToken(SkillRegistryPort), {
    useValue: new FakeSkillRegistry({ skills: [] }),
  })
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

  it('holds the ported prose and nothing but the fragments added since', () => {
    expect(prose()).toBe(
      `${MINIMAL_PREAMBLE}\n${PROJECT_DIRECTORY}\n${RELATIVE_PATHS}\n${READ_BEFORE_WRITE}`,
    )
  })
})

describe('the project-directory sentence, split at the static/live seam', () => {
  it('states the project directory, which is fixed for the session', () => {
    expect(compiled().parts[2]?.text).toStartWith(`The project directory is ${ROOT},`)
  })

  it('tells the model to hold the directory still rather than to steer it', () => {
    expect(compiled().parts[2]?.text).toEndWith(
      'never spend a cd returning to it, and run somewhere else by passing that directory as workdir rather than by cd.',
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

describe('the rule the file guard enforces, said once where the model reads it', () => {
  it('sits after the path rules, since it is about what you may do to a path', () => {
    expect(compiled().parts[4]?.id).toBe('files.read-before-write')
    expect(compiled().parts[4]?.text).toBe(READ_BEFORE_WRITE)
  })

  it('separates the two tools the guard treats differently', () => {
    expect(READ_BEFORE_WRITE).toContain('write replaces a file whole')
    expect(READ_BEFORE_WRITE).toContain('edit needs no prior read')
  })

  it('says what a search buys and what a shell read does not', () => {
    expect(READ_BEFORE_WRITE).toContain('grep gives you only the lines it matched')
    expect(READ_BEFORE_WRITE).toContain('the shell gives you nothing that is tracked at all')
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

The project directory is /Users/dev/project, and every bash command starts there. You are already in it, so never spend a cd returning to it, and run somewhere else by passing that directory as workdir rather than by cd.

A path you pass to a tool resolves against the project directory, so write those relative to it. A path inside a bash command is resolved by the shell instead, against workdir or the project directory, so write those absolute.

write replaces a file whole, so an existing file has to have been read whole before you may
replace it. read gives you that; grep gives you only the lines it matched; reading a file through
the shell gives you nothing that is tracked at all. edit needs no prior read, because its old text
has to match — an unanchored change fails rather than lands.

Every file you have read is watched. If it changes underneath you, the next write or edit to it is
refused until you have read it again.`,
      },
    ])
  })

  it('measures each fragment so the compile reads as a budget', () => {
    expect(compiled().parts.map((part) => part.chars)).toEqual(
      compiled().parts.map((part) => part.text.length),
    )
  })

  it('skips none of the ported prose, none of which is conditional', () => {
    expect(compiled().skipped).toEqual([
      { id: 'skills.listing', reason: ESkipReason.Empty },
    ])
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
      'files.read-before-write',
      'skills.listing',
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
          projectDirectory: '/w',
        }),
      }),
    ).toEqual([])
  })
})

describe('the registry is one instance per container, so its memo is not incidental', () => {
  it('hands back the same registry however many times it is resolved', () => {
    const container = registered()

    const first = container.resolve(portToken(PromptRegistry))
    const second = container.resolve(portToken(PromptRegistry))

    expect(first).toBe(second)
  })
})
