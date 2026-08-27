import { describe, expect, it } from 'bun:test'

import { EContextSlot } from '../slot'
import { contextBlock, wrapInSystemReminder } from '../render'

describe('wrapInSystemReminder', () => {
  it('fences the text so the model can tell it apart from what a human typed', () => {
    expect(wrapInSystemReminder('be careful')).toBe(
      '<system-reminder>\nbe careful\n</system-reminder>',
    )
  })
})

describe('contextBlock provenance', () => {
  const blockFor = (args: { slot: EContextSlot; key: string }): string =>
    contextBlock({ slot: args.slot, key: args.key, content: '# rules' })

  it('says a checked-in project file is checked in', () => {
    expect(blockFor({ slot: EContextSlot.ProjectInstructions, key: '/repo/CLAUDE.md' })).toContain(
      'Contents of /repo/CLAUDE.md (project instructions, checked into the codebase):',
    )
  })

  it('says a local project file is not checked in', () => {
    expect(
      blockFor({ slot: EContextSlot.ProjectInstructions, key: '/repo/CLAUDE.local.md' }),
    ).toContain("Contents of /repo/CLAUDE.local.md (the user's private project instructions, not checked in):")
  })

  it('treats an AGENTS.local.md the same way as a CLAUDE.local.md', () => {
    expect(
      blockFor({ slot: EContextSlot.ProjectInstructions, key: '/repo/AGENTS.local.md' }),
    ).toContain('not checked in')
  })

  it('does not mistake a file merely containing the word local for a local file', () => {
    expect(blockFor({ slot: EContextSlot.ProjectInstructions, key: '/repo/local/CLAUDE.md' })).toContain(
      'checked into the codebase',
    )
  })

  it('marks a user file as global and private', () => {
    expect(blockFor({ slot: EContextSlot.UserInstructions, key: '/home/dev/.claude/CLAUDE.md' })).toContain(
      "Contents of /home/dev/.claude/CLAUDE.md (the user's private global instructions for all projects):",
    )
  })

  it('explains why a nested file appeared, since the model did not ask for it', () => {
    const block = blockFor({ slot: EContextSlot.NestedInstructions, key: '/repo/apps/tui/CLAUDE.md' })

    expect(block).toContain('Contents of /repo/apps/tui/CLAUDE.md')
    expect(block).toContain('a tool touched a file beneath it')
  })

  it('wraps every block in a system reminder', () => {
    const block = blockFor({ slot: EContextSlot.ProjectInstructions, key: '/repo/CLAUDE.md' })

    expect(block.startsWith('<system-reminder>\n')).toBe(true)
    expect(block.endsWith('\n</system-reminder>')).toBe(true)
    expect(block).toContain('# rules')
  })

  it('leaves a listing to describe itself, having no path to attribute', () => {
    const block = contextBlock({
      slot: EContextSlot.SkillListing,
      key: 'skills',
      content: 'The following skills are available',
    })

    expect(block).toBe('<system-reminder>\nThe following skills are available\n</system-reminder>')
  })

  it('leaves an unrecognised slot unattributed rather than guessing', () => {
    expect(contextBlock({ slot: 'something-new', key: '/repo/x', content: 'body' })).toBe(
      '<system-reminder>\nbody\n</system-reminder>',
    )
  })
})
