import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EDefinitionOrigin } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import type { AgentType } from '../agent-type'
import { BUILT_IN_AGENT_TYPES } from '../built-ins'
import { loadAgentTypes } from '../registry'
import { agentTypeRootPlan, agentTypeSources } from '../roots'

let workspace: string

const homeOf = (): string => join(workspace, 'home')
const projectOf = (): string => join(workspace, 'project')

const writeAgentType = (args: { at: string; name: string; description: string; body: string }) => {
  const directory = join(workspace, args.at)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${args.name}.md`),
    ['---', `description: ${args.description}`, '---', args.body].join('\n'),
  )
}

const catalogue = async () =>
  loadAgentTypes({
    sources: await agentTypeSources({
      atlasHome: join(homeOf(), '.atlas'),
      home: homeOf(),
      cwd: projectOf(),
    }),
  })

const loaded = async (): Promise<readonly AgentType[]> => (await catalogue()).types

const named = (types: readonly AgentType[], name: string): AgentType | undefined =>
  types.find((agentType) => agentType.name === name)

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'atlas-agent-roots-'))
  mkdirSync(projectOf(), { recursive: true })
})

describe('agentTypeRootPlan', () => {
  it('reads the agents directory of every flavour, user before project', () => {
    const plan = agentTypeRootPlan({ atlasHome: '/h/.atlas', home: '/h', cwd: '/w' })

    expect(plan.map((root) => root.directory)).toEqual([
      '/h/.atlas/agents',
      '/h/.agents/agents',
      '/h/.claude/agents',
      '/w/.atlas/agents',
      '/w/.agents/agents',
      '/w/.claude/agents',
    ])
    expect(plan.map((root) => root.origin)).toEqual([
      EDefinitionOrigin.User,
      EDefinitionOrigin.User,
      EDefinitionOrigin.User,
      EDefinitionOrigin.Project,
      EDefinitionOrigin.Project,
      EDefinitionOrigin.Project,
    ])
  })
})

describe('agentTypeSources', () => {
  it('offers the built-ins alone when no directory exists', async () => {
    expect((await loaded()).map((agentType) => agentType.name).sort()).toEqual(
      BUILT_IN_AGENT_TYPES.map((agentType) => agentType.name).sort(),
    )
  })

  it('picks up a project file and stamps it as the project', async () => {
    writeAgentType({
      at: 'project/.atlas/agents',
      name: 'migrator',
      description: 'move a schema',
      body: 'Migrate.',
    })

    const migrator = named(await loaded(), 'migrator')
    expect(migrator?.whenToUse).toBe('move a schema')
    expect(migrator?.origin).toBe(EDefinitionOrigin.Project)
  })

  it('lets a project file shadow a user file, and a user file shadow a built-in', async () => {
    writeAgentType({
      at: 'home/.claude/agents',
      name: 'reviewer',
      description: 'review my way',
      body: 'User prompt.',
    })
    writeAgentType({
      at: 'home/.agents/agents',
      name: 'auditor',
      description: 'audit my way',
      body: 'User prompt.',
    })
    writeAgentType({
      at: 'project/.agents/agents',
      name: 'auditor',
      description: 'audit this repository',
      body: 'Project prompt.',
    })

    const types = await loaded()
    expect(named(types, 'reviewer')?.prompt).toBe('User prompt.')
    expect(named(types, 'reviewer')?.origin).toBe(EDefinitionOrigin.User)
    expect(named(types, 'auditor')?.prompt).toBe('Project prompt.')
    expect(named(types, 'auditor')?.origin).toBe(EDefinitionOrigin.Project)
  })

  it('lets the atlas flavour win over the others of the same origin', async () => {
    writeAgentType({
      at: 'project/.claude/agents',
      name: 'auditor',
      description: 'the claude file',
      body: 'Claude prompt.',
    })
    writeAgentType({
      at: 'project/.atlas/agents',
      name: 'auditor',
      description: 'the atlas file',
      body: 'Atlas prompt.',
    })

    expect(named(await loaded(), 'auditor')?.prompt).toBe('Atlas prompt.')
  })

  it('survives a file it cannot parse', async () => {
    const directory = join(workspace, 'project/.atlas/agents')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'broken.md'), 'no frontmatter here')
    writeAgentType({
      at: 'project/.atlas/agents',
      name: 'migrator',
      description: 'move a schema',
      body: 'Migrate.',
    })

    const names = (await loaded()).map((agentType) => agentType.name)
    expect(names).toContain('migrator')
    expect(names).not.toContain('broken')
  })
})
