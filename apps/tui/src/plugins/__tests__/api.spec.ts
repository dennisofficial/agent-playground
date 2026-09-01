import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import {
  PLUGIN_TYPES_FILE_NAME,
  renderPluginTypes,
  workspaceRootOfThisScript,
  writePluginTypes,
} from '../../../scripts/generate-plugin-types'
import { PLUGIN_API_MODULES, atlasPluginApi } from '../api'

const DECLARED_VALUE = /^ {2}export const (\w+):/gm

const DECLARED_TYPE = /^ {2}export type (\w+) =/gm

const namesMatching = (args: { pattern: RegExp; text: string }): readonly string[] =>
  [...args.text.matchAll(args.pattern)].map((match) => match[1] ?? '').sort()

const rendered = renderPluginTypes({ declarationRoot: '/declarations' })

describe('the shipped types and the curated api', () => {
  it('declares exactly the values atlasPluginApi exports', () => {
    expect(namesMatching({ pattern: DECLARED_VALUE, text: rendered })).toEqual(
      Object.keys(atlasPluginApi).sort(),
    )
  })

  it('claims a companion type only for a name the api actually exports', () => {
    const claimed = PLUGIN_API_MODULES.flatMap((module) => module.valueTypes)

    expect(claimed.filter((name) => !(name in atlasPluginApi))).toEqual([])
  })

  it('declares a type for every value that is also a type, and for every type-only name', () => {
    const expected = PLUGIN_API_MODULES.flatMap((module) => [...module.valueTypes, ...module.types])

    expect(namesMatching({ pattern: DECLARED_TYPE, text: rendered })).toEqual([...expected].sort())
  })

  it('points every declaration at the declaration root it was handed', () => {
    expect(rendered).toContain("import('/declarations/packages/core/src/index')")
    expect(rendered).toContain("import('/declarations/apps/tui/src/plugins/plugin')")
  })
})

describe('a fixture plugin typechecked against the emitted file', () => {
  it('resolves every name it imports and types a hook body without an implicit any', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-plugin-types-'))

    await writePluginTypes({ sourceRoot: workspaceRootOfThisScript(), directory })

    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          lib: ['ES2023'],
          module: 'Preserve',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
        },
        files: ['./fixture.ts', `./${PLUGIN_TYPES_FILE_NAME}`],
      }),
    )

    writeFileSync(
      join(directory, 'fixture.ts'),
      `
import { definePlugin, EBeforeToolDecision, EHookPhase, EStage, EToolEffect, readCommand } from 'atlas'
import type { BeforeToolOutcome, PluginContribution, PluginHost, ToolCall } from 'atlas'

const decide = async (args: {
  call: ToolCall
  projectDirectory: string
}): Promise<BeforeToolOutcome> => {
  const reading = readCommand({
    command: String(args.call.input),
    workdir: undefined,
    projectDirectory: args.projectDirectory,
  })

  if (args.call.effect === EToolEffect.Read || reading.segments.length === 0) {
    return { decision: EBeforeToolDecision.Allow, input: args.call.input }
  }

  return { decision: EBeforeToolDecision.Deny, reason: 'this repo uses bun' }
}

export default definePlugin({
  id: 'comp-conventions',
  register: (host: PluginHost): PluginContribution => ({
    hooks: [
      {
        phase: EHookPhase.BeforeTool,
        name: host.id,
        order: { stage: EStage.Guard, nudge: 10 },
        run: async ({ call, projectDirectory }) => await decide({ call, projectDirectory }),
      },
    ],
  }),
})
`,
    )

    const checked = Bun.spawn(['bunx', 'tsc', '--noEmit', '-p', directory], {
      cwd: workspaceRootOfThisScript(),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const reported = await new Response(checked.stdout).text()

    expect(reported.trim()).toBe('')
    expect(await checked.exited).toBe(0)
  }, 60_000)
})
