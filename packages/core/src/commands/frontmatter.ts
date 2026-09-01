import { parseFrontmatter } from '../yaml/parse'
import { isYamlScalar } from '../yaml/value'

export type Frontmatter = { fields: ReadonlyMap<string, string>; body: string }

export function splitFrontmatter(text: string): Frontmatter {
  const { document, body } = parseFrontmatter(text)

  const fields = new Map<string, string>()
  for (const [key, value] of document) {
    if (isYamlScalar(value)) fields.set(key, value)
  }

  return { fields, body }
}
