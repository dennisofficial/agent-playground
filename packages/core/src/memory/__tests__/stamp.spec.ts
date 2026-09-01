import { describe, expect, it } from 'bun:test'

import { withRecordedDate } from '../stamp'

const DATE = '2026-09-01'

const memory = (body: string): string => `---\n${body}\n---\n\nThe claim.\n`

describe('withRecordedDate', () => {
  it('adds the date as the last frontmatter line when none is there', () => {
    const stamped = withRecordedDate({ content: memory('name: a\ntype: project'), date: DATE })

    expect(stamped).toBe(`---\nname: a\ntype: project\nrecorded: ${DATE}\n---\n\nThe claim.\n`)
  })

  it('overwrites a date the model invented rather than trusting it', () => {
    const stamped = withRecordedDate({
      content: memory('name: a\nrecorded: 1999-01-01\ntype: project'),
      date: DATE,
    })

    expect(stamped).toContain(`recorded: ${DATE}`)
    expect(stamped).not.toContain('1999-01-01')
  })

  it('returns the content unchanged when the date is already right, so no byte moves', () => {
    const content = memory(`name: a\ntype: project\nrecorded: ${DATE}`)

    expect(withRecordedDate({ content, date: DATE })).toBe(content)
  })

  it('leaves the body alone, including a fence inside it', () => {
    const content = `---\nname: a\n---\n\nBefore\n\n---\n\nAfter\n`

    expect(withRecordedDate({ content, date: DATE })).toBe(
      `---\nname: a\nrecorded: ${DATE}\n---\n\nBefore\n\n---\n\nAfter\n`,
    )
  })

  it('invents no frontmatter for a file that has none', () => {
    const content = 'Just prose, no fence.\n'

    expect(withRecordedDate({ content, date: DATE })).toBe(content)
  })

  it('leaves an unterminated frontmatter block alone rather than guessing where it ends', () => {
    const content = '---\nname: a\n\nstill going\n'

    expect(withRecordedDate({ content, date: DATE })).toBe(content)
  })

  it('keeps CRLF line endings when that is what the file uses', () => {
    const content = '---\r\nname: a\r\n---\r\n\r\nThe claim.\r\n'

    expect(withRecordedDate({ content, date: DATE })).toBe(
      `---\r\nname: a\r\nrecorded: ${DATE}\r\n---\r\n\r\nThe claim.\r\n`,
    )
  })
})
