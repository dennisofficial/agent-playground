export enum EContextSlot {
  UserInstructions = 'user-instructions',
  ProjectInstructions = 'project-instructions',
  NestedInstructions = 'nested-instructions',
  Skill = 'skill',
  SkillListing = 'skill-listing',
  McpInstructions = 'mcp-instructions',
}

const SLOT_VALUES: readonly string[] = Object.values(EContextSlot)

export const isContextSlot = (value: string): value is EContextSlot => SLOT_VALUES.includes(value)
