import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  SchemaTool,
  type DeclaredPathField,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'
import { z } from 'zod'

import { ESkillInstallLayer, writeSkill } from '../../skills/install-writer'
import { SKILL_ENTRY_FILENAME } from '../../skills/skill'

const inputSchema = z.strictObject({
  layer: z.enum(ESkillInstallLayer),
  name: z
    .string()
    .min(1)
    .regex(/^[^/]+$/, "a skill name cannot contain '/'"),
  body: z.string().min(1),
})

const description = [
  `Install a skill by writing its ${SKILL_ENTRY_FILENAME} under a skills root — the shape for "install the X skill", where the model drops the body itself.`,
  'layer: user installs it for every project under the atlas home (~/.atlas/skills by default), project installs it under <project>/.atlas/skills.',
  `name is the folder the skill lives in and body is the whole ${SKILL_ENTRY_FILENAME} text, frontmatter and all.`,
  'Overwriting a same-named skill is allowed; the ordinary shadowing between layers decides which copy wins.',
].join(' ')

export class SkillInstallTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'skill_install'
  readonly description = description
  readonly effect = EToolEffect.Write
  readonly inputSchema = inputSchema

  override readonly pathFields: readonly DeclaredPathField[] = [
    {
      field: 'name',
      presence: EPathPresence.Required,
      form: EPathForm.RelativeToBase,
      content: EContentAccess.Overwrites,
    },
  ]

  protected override async run({
    input,
    projectDirectory,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const installed = await writeSkill({ ...input, cwd: projectDirectory })
    if (!installed.ok) return { ok: false, reason: installed.reason }

    return {
      ok: true,
      output: {
        path: installed.path,
        bytes: installed.bytes,
        name: input.name,
        layer: input.layer,
      },
      modelText: `the ${input.name} skill is installed at ${installed.path}`,
    }
  }
}
