import { ATLAS_SETTINGS, EInstructionFamily, ESettingId } from '@dltech/atlas-core'
import { createSettingsService, MemorySettingsStore } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { instructionPlanOf } from '../instruction-plan'

const CWD = '/workspace'

const planWith = (values: Record<string, boolean | string | number>) =>
  instructionPlanOf({
    settings: createSettingsService({
      definitions: ATLAS_SETTINGS,
      user: new MemorySettingsStore({ document: { values } }),
    }),
    cwd: CWD,
  })

describe('instructionPlanOf', () => {
  it('loads both families from the workspace and the user directory by default', () => {
    const plan = planWith({})

    expect(plan.request.family).toBe(EInstructionFamily.Both)
    expect(plan.request.includeProject).toBe(true)
    expect(plan.request.includeUser).toBe(true)
    expect(plan.request.root).toBe(CWD)
    expect(plan.reload).toBe(true)
  })

  it('narrows the family when the filenames setting names one', () => {
    expect(planWith({ [ESettingId.InstructionFilenames]: 'claude' }).request.family).toBe(
      EInstructionFamily.Claude,
    )
    expect(planWith({ [ESettingId.InstructionFilenames]: 'agents' }).request.family).toBe(
      EInstructionFamily.Agents,
    )
  })

  it('honours the toggles that switch a source off', () => {
    const plan = planWith({
      [ESettingId.UserInstructions]: false,
      [ESettingId.ProjectInstructions]: false,
      [ESettingId.ReloadInstructions]: false,
    })

    expect(plan.request.includeUser).toBe(false)
    expect(plan.request.includeProject).toBe(false)
    expect(plan.reload).toBe(false)
  })
})
