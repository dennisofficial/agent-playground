import { describe, expect, it } from 'bun:test'

import { EPromptAgent, PromptFragment } from '@dltech/atlas-core'

import { createIsolatedContainer, portToken } from '../../container/injection'
import { MemoryFragment } from '../fragments/memory'
import { registerBuiltinPromptFragments } from '../register-prompt-fragments'
import { PromptRegistry } from '../registry'
import { SkillRegistryPort } from '../../skills/port'
import { contextFor } from './fake-fragments'
import { FakeSkillRegistry } from './fake-skills'

const DIRECTORIES = { user: '/home/.atlas/memory', project: '/home/.atlas/projects/-repo/memory' }

const mainContext = contextFor({ modelId: 'claude-opus-5' })

describe('the memory fragment in the composed prompt', () => {
  it('reaches the compiled prompt even though it registers after the builtins', () => {
    const container = createIsolatedContainer()
    container.register(portToken(SkillRegistryPort), {
      useValue: new FakeSkillRegistry({ skills: [] }),
    })
    registerBuiltinPromptFragments({ container })
    container.register(portToken(PromptFragment), {
      useValue: new MemoryFragment({ directories: DIRECTORIES }),
    })

    const compiled = container.resolve(portToken(PromptRegistry)).compile(mainContext)

    expect(compiled.parts.map((part) => part.id)).toContain('memory.instructions')
    expect(compiled.blocks[0]?.text).toContain(DIRECTORIES.project)
    expect(compiled.blocks[0]?.text).toContain(DIRECTORIES.user)
  })

  it('names both directories and the index it will be handed', () => {
    const text = new MemoryFragment({ directories: DIRECTORIES }).text()

    expect(text).toContain(DIRECTORIES.user)
    expect(text).toContain(DIRECTORIES.project)
    expect(text).toContain('MEMORY.md')
  })

  it('is withheld from a sub-agent, so children never become concurrent writers', () => {
    const fragment = new MemoryFragment({ directories: DIRECTORIES })

    expect(fragment.applies({ ...mainContext, agent: EPromptAgent.Main })).toBe(true)
    expect(fragment.applies({ ...mainContext, agent: EPromptAgent.Sub })).toBe(false)
  })
})
