import { tmpdir } from 'node:os'

import { describe, expect, it } from 'bun:test'

import {
  EPromptAgent,
  PromptFragment,
  ToolDefinition,
  modelEntry,
  toThreadId,
  type PromptContext,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { createHarnessContainer } from '../../container/create-harness-container'
import { portToken, resolveSet, type DependencyContainer } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { registerBuiltinPromptFragments } from '../../prompt/register-prompt-fragments'
import { SkillListingFragment } from '../../prompt/fragments/skills'

const OPUS: PromptContext = {
  agent: EPromptAgent.Main,
  provider: { id: 'anthropic-oauth', modelId: 'claude-opus-5' },
  model: modelEntry('claude-opus-5'), projectDirectory: '/w'
}

const wired = (): DependencyContainer => {
  const container = createHarnessContainer()
  container.register(WorkspaceRoot, { useValue: tmpdir() })
  registerBuiltinPromptFragments({ container })
  return container
}

const skillTool = (container: DependencyContainer): ToolDefinition => {
  const found = resolveSet({ container, token: portToken(ToolDefinition) }).find(
    (tool) => tool.name === 'skill',
  )
  if (found === undefined) throw new Error('the container resolved no tool named "skill"')
  return found
}

const listingFragment = (container: DependencyContainer): SkillListingFragment => {
  const found = resolveSet({ container, token: portToken(PromptFragment) }).find(
    (fragment) => fragment.id === 'skills.listing',
  )
  if (!(found instanceof SkillListingFragment)) {
    throw new Error('the container resolved no fragment "skills.listing"')
  }
  return found
}

const invoke = (tool: ToolDefinition, input: unknown): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: AbortSignal.timeout(10_000),
    idempotencyKey: 'key-1',
    projectDirectory: tmpdir(),
    threadId: toThreadId('thread-1'),
  })

describe('the skill registry the tool and the listing share', () => {
  it('hands the skill tool a registry it can actually ask, rather than a phantom', async () => {
    const outcome = await invoke(skillTool(wired()), { name: 'nothing-is-named-this' })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('no skill is named')
  })

  it('hands the listing fragment a registry it can read, so compiling a prompt does not throw', () => {
    const fragment = listingFragment(wired())

    expect(() => fragment.text(OPUS)).not.toThrow()
  })

  it('emits no listing header before anything has awaited the first reload', () => {
    expect(listingFragment(wired()).text(OPUS)).toBe('')
  })
})
