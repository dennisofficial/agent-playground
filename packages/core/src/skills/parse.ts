import { splitOutsideGroups } from '../yaml/scalar'
import { isYamlList, isYamlMap, isYamlScalar, type YamlMap, type YamlValue } from '../yaml/value'
import { ESkillContext, ESkillEffort, ESkillShell, type SkillFrontmatter } from './spec'

export const SKILL_METADATA_KEY = 'metadata'

const CONSUMED_KEYS: readonly string[] = [
  'name',
  'description',
  'when_to_use',
  'when-to-use',
  'license',
  'compatibility',
  SKILL_METADATA_KEY,
  'allowed-tools',
  'disallowed-tools',
  'argument-hint',
  'arguments',
  'user-invocable',
  'disable-model-invocation',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'paths',
  'shell',
]

const AFFIRMATIVE: readonly string[] = ['1', 'true', 'on', 'yes']
const NEGATIVE: readonly string[] = ['0', 'false', 'off', 'no']

const isListSeparator = (character: string): boolean => character === ',' || /\s/.test(character)
const isCommaSeparator = (character: string): boolean => character === ','

const textAt = (document: YamlMap, key: string): string | undefined => {
  const value = document.get(key)
  if (!isYamlScalar(value)) return undefined

  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

const flowTextOf = (entries: readonly YamlValue[]): string =>
  `[${entries.filter(isYamlScalar).join(', ')}]`

const hintAt = (document: YamlMap, key: string): string | undefined => {
  const value = document.get(key)
  if (!isYamlList(value)) return textAt(document, key)

  const rendered = flowTextOf(value)
  return rendered === '[]' ? undefined : rendered
}

const entriesOf = (args: {
  value: YamlValue | undefined
  isSeparator: (character: string) => boolean
}): readonly string[] => {
  if (isYamlList(args.value)) {
    return args.value
      .filter(isYamlScalar)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
  }
  if (!isYamlScalar(args.value)) return []

  return splitOutsideGroups({ text: args.value, isSeparator: args.isSeparator })
}

const booleanOf = (args: { written: string | undefined; fallback: boolean }): boolean => {
  const word = args.written?.trim().toLowerCase()
  if (word === undefined) return args.fallback
  if (AFFIRMATIVE.includes(word)) return true
  if (NEGATIVE.includes(word)) return false
  return args.fallback
}

const optionalBooleanOf = (written: string | undefined): boolean | undefined => {
  const word = written?.trim().toLowerCase()
  if (word === undefined) return undefined
  if (AFFIRMATIVE.includes(word)) return true
  if (NEGATIVE.includes(word)) return false
  return undefined
}

const effortOf = (written: string | undefined): ESkillEffort | undefined => {
  if (written === undefined) return undefined

  const word = written.trim().toLowerCase()
  return Object.values(ESkillEffort).find((effort) => effort === word)
}

const contextOf = (written: string | undefined): ESkillContext =>
  written?.trim().toLowerCase() === ESkillContext.Fork ? ESkillContext.Fork : ESkillContext.Inline

const shellOf = (written: string | undefined): ESkillShell =>
  written?.trim().toLowerCase() === ESkillShell.PowerShell
    ? ESkillShell.PowerShell
    : ESkillShell.Bash

const metadataOf = (value: YamlValue | undefined): ReadonlyMap<string, string> => {
  if (!isYamlMap(value)) return new Map()

  const coerced = new Map<string, string>()
  for (const [key, held] of value) {
    if (isYamlScalar(held)) coerced.set(key, held)
  }
  return coerced
}

const unrecognisedOf = (document: YamlMap): YamlMap => {
  const kept = new Map<string, YamlValue>()

  for (const [key, value] of document) {
    if (!CONSUMED_KEYS.includes(key)) kept.set(key, value)
  }

  const metadata = document.get(SKILL_METADATA_KEY)
  if (metadata !== undefined && !isYamlMap(metadata)) kept.set(SKILL_METADATA_KEY, metadata)

  return kept
}

const nameOf = (args: { document: YamlMap; fallbackName: string }): string => {
  const written = textAt(args.document, 'name')
  return (written ?? args.fallbackName).trim().toLowerCase()
}

export function skillFrontmatterOf(args: {
  document: YamlMap
  fallbackName: string
}): SkillFrontmatter {
  const { document } = args

  return {
    name: nameOf(args),
    description: textAt(document, 'description') ?? '',
    whenToUse: textAt(document, 'when_to_use') ?? textAt(document, 'when-to-use'),
    license: textAt(document, 'license'),
    compatibility: textAt(document, 'compatibility'),
    metadata: metadataOf(document.get(SKILL_METADATA_KEY)),
    allowedTools: entriesOf({
      value: document.get('allowed-tools'),
      isSeparator: isListSeparator,
    }),
    disallowedTools: entriesOf({
      value: document.get('disallowed-tools'),
      isSeparator: isListSeparator,
    }),
    argumentHint: hintAt(document, 'argument-hint'),
    argumentNames: entriesOf({ value: document.get('arguments'), isSeparator: isListSeparator }),
    userInvocable: booleanOf({ written: textAt(document, 'user-invocable'), fallback: true }),
    modelInvocable: !booleanOf({
      written: textAt(document, 'disable-model-invocation'),
      fallback: false,
    }),
    model: textAt(document, 'model'),
    effort: effortOf(textAt(document, 'effort')),
    context: contextOf(textAt(document, 'context')),
    agent: textAt(document, 'agent'),
    background: optionalBooleanOf(textAt(document, 'background')),
    paths: entriesOf({ value: document.get('paths'), isSeparator: isCommaSeparator }),
    shell: shellOf(textAt(document, 'shell')),
    unrecognised: unrecognisedOf(document),
  }
}
