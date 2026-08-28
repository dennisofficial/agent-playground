import { EInstructionFamily, ESettingId } from '@dltech/atlas-core'
import { atlasDirectory, type InstructionPlan, type SettingsService } from '@dltech/atlas-harness'

const familyOf = (value: unknown): EInstructionFamily => {
  if (value === EInstructionFamily.Claude) return EInstructionFamily.Claude
  if (value === EInstructionFamily.Agents) return EInstructionFamily.Agents
  return EInstructionFamily.Both
}

export function instructionPlanOf(args: {
  settings: SettingsService
  cwd: string
}): InstructionPlan {
  const resolved = args.settings.snapshot().resolution.settings
  const enabled = (id: ESettingId): boolean => resolved.get(id)?.value !== false

  return {
    request: {
      root: args.cwd,
      cwd: args.cwd,
      userDirectories: [atlasDirectory()],
      family: familyOf(resolved.get(ESettingId.InstructionFilenames)?.value),
      includeUser: enabled(ESettingId.UserInstructions),
      includeProject: enabled(ESettingId.ProjectInstructions),
    },
    reload: enabled(ESettingId.ReloadInstructions),
  }
}
