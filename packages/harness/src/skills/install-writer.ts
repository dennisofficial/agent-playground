import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomically } from '../files/atomic-write'
import { projectSkillsDirectory, userSkillsDirectory } from '../settings/paths'
import { SKILL_ENTRY_FILENAME } from './skill'

export enum ESkillInstallLayer {
  User = 'user',
  Project = 'project',
}

export type SkillInstallRequest = {
  layer: ESkillInstallLayer
  name: string
  body: string
}

export type SkillInstallOutcome =
  | { ok: true; path: string; bytes: number }
  | { ok: false; reason: string }

const skillsRootOf = (args: { layer: ESkillInstallLayer; cwd: string }): string =>
  args.layer === ESkillInstallLayer.User
    ? userSkillsDirectory()
    : projectSkillsDirectory(args.cwd)

const nameProblem = (name: string): string | undefined => {
  if (name.trim() === '') return 'a skill needs a name'
  if (name.includes('/')) return `a skill name cannot contain '/': ${name}`
  return undefined
}

export async function writeSkill(
  args: SkillInstallRequest & { cwd: string },
): Promise<SkillInstallOutcome> {
  const badName = nameProblem(args.name)
  if (badName !== undefined) return { ok: false, reason: badName }

  if (args.body.trim() === '') return { ok: false, reason: 'a skill needs a body' }

  const path = join(skillsRootOf({ layer: args.layer, cwd: args.cwd }), args.name, SKILL_ENTRY_FILENAME)

  const existing = await stat(path).catch(() => null)
  if (existing !== null && !existing.isFile()) {
    return { ok: false, reason: `${path} already exists and is not a regular file.` }
  }

  const bytes = await writeFileAtomically({ path, content: args.body, mode: existing?.mode })

  return { ok: true, path, bytes }
}
