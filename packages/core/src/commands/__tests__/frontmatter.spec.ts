import { describe, expect, it } from 'bun:test'

import { expandSkillBody } from '../expand'
import { splitFrontmatter } from '../frontmatter'

describe('splitFrontmatter', () => {
  it('reads scalar fields and returns the body beneath', () => {
    const { fields, body } = splitFrontmatter('---\nname: Advisor\ndescription: be blunt\n---\nBody here')

    expect(fields.get('name')).toBe('Advisor')
    expect(fields.get('description')).toBe('be blunt')
    expect(body).toBe('Body here')
  })

  it('tolerates a key it does not know', () => {
    const { fields } = splitFrontmatter('---\nallowed-tools: bash\n---\nBody')

    expect(fields.get('allowed-tools')).toBe('bash')
  })

  it('strips quotes from a value', () => {
    const { fields } = splitFrontmatter('---\nname: "Advisor"\n---\nBody')

    expect(fields.get('name')).toBe('Advisor')
  })

  it('keeps a colon that appears inside a value', () => {
    const { fields } = splitFrontmatter('---\ndescription: see https://x.com/a\n---\nBody')

    expect(fields.get('description')).toBe('see https://x.com/a')
  })

  it('returns the whole text as body when there is no fence', () => {
    expect(splitFrontmatter('Just a body').body).toBe('Just a body')
  })

  it('returns the whole text as body when the fence never closes', () => {
    const text = '---\nname: Broken\nstill going'

    expect(splitFrontmatter(text).body).toBe(text)
  })
})

describe('expandSkillBody', () => {
  it('substitutes the whole argument text', () => {
    expect(expandSkillBody({ body: 'Review $ARGUMENTS now', argumentText: 'a.ts b.ts' })).toBe(
      'Review a.ts b.ts now',
    )
  })

  it('substitutes positional arguments', () => {
    expect(expandSkillBody({ body: 'from $1 to $2', argumentText: 'a.ts b.ts' })).toBe(
      'from a.ts to b.ts',
    )
  })

  it('leaves a positional placeholder alone when nothing was passed', () => {
    expect(expandSkillBody({ body: 'from $1 to $2', argumentText: 'a.ts' })).toBe('from a.ts to $2')
  })

  it('expands an absent argument text to nothing', () => {
    expect(expandSkillBody({ body: 'Review $ARGUMENTS.', argumentText: '' })).toBe('Review .')
  })
})
