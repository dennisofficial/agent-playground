export type PureViolation = { path: string; line: string; rule: string }

const IMPURE_REACHES = /\b(require\(|fetch\(|process\.|Bun\.|globalThis\.)/

const IMPURE_AMBIENT = /\b(Date\.now|new Date|Math\.random|crypto\.)/

const FOREIGN_IMPORT = /from\s+['"](?!\.\.?\/)(?!zod['"])(?!@dltech\/atlas-core['"])/

const ESCAPING_IMPORT = /from\s+['"]\.\.\//

const RULES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'reaches for the filesystem, network, database or process', pattern: IMPURE_REACHES },
  { name: 'reads a clock or draws randomness', pattern: IMPURE_AMBIENT },
  { name: 'imports something other than zod or atlas-core', pattern: FOREIGN_IMPORT },
  { name: 'imports from outside its own pure directory', pattern: ESCAPING_IMPORT },
]

export function violationsIn(args: { path: string; text: string }): readonly PureViolation[] {
  return args.text.split('\n').flatMap((line) =>
    RULES.filter((rule) => rule.pattern.test(line)).map((rule) => ({
      path: args.path,
      line: line.trim(),
      rule: rule.name,
    })),
  )
}
