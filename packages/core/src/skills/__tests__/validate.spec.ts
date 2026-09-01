import { describe, expect, it } from 'bun:test'

import { parseYaml } from '../../yaml/parse'
import { skillFrontmatterOf } from '../parse'
import { ESkillWarning } from '../spec'
import { validateSkill } from '../validate'

const codesOf = (args: { text: string; directoryName?: string | undefined }) =>
  validateSkill({
    frontmatter: skillFrontmatterOf({ document: parseYaml(args.text), fallbackName: '' }),
    directoryName: args.directoryName,
  }).map((warning) => warning.code)

describe('validateSkill', () => {
  it('reports nothing for a well formed skill', () => {
    expect(codesOf({ text: 'name: code-review\ndescription: reviews code' })).toEqual([])
  })

  it('reports a missing name and stops looking at the name', () => {
    expect(codesOf({ text: 'description: a' })).toEqual([ESkillWarning.MissingName])
  })

  it('reports a name that is too long', () => {
    const name = 'a'.repeat(65)

    expect(codesOf({ text: `name: ${name}\ndescription: a` })).toEqual([ESkillWarning.NameTooLong])
  })

  it('reports a name outside the allowed charset', () => {
    expect(codesOf({ text: 'name: code_review\ndescription: a' })).toEqual([
      ESkillWarning.NameCharset,
    ])
  })

  it('reports hyphens on the edges and doubled hyphens', () => {
    expect(codesOf({ text: 'name: -review-\ndescription: a' })).toEqual([
      ESkillWarning.NameHyphenEdges,
    ])
    expect(codesOf({ text: 'name: code--review\ndescription: a' })).toEqual([
      ESkillWarning.NameDoubleHyphen,
    ])
  })

  it('reports a name that does not match its directory', () => {
    expect(codesOf({ text: 'name: review\ndescription: a', directoryName: 'code-review' })).toEqual(
      [ESkillWarning.NameDirectoryMismatch],
    )
  })

  it('says nothing about the directory when none is given', () => {
    expect(codesOf({ text: 'name: review\ndescription: a' })).toEqual([])
  })

  it('reports a missing description', () => {
    expect(codesOf({ text: 'name: review' })).toEqual([ESkillWarning.MissingDescription])
  })

  it('reports an over-long description and compatibility', () => {
    const text = `name: review\ndescription: ${'d'.repeat(1025)}\ncompatibility: ${'c'.repeat(501)}`

    expect(codesOf({ text })).toEqual([
      ESkillWarning.DescriptionTooLong,
      ESkillWarning.CompatibilityTooLong,
    ])
  })

  it('reports metadata that is not a map', () => {
    expect(codesOf({ text: 'name: review\ndescription: a\nmetadata: nope' })).toEqual([
      ESkillWarning.MetadataNotAMap,
    ])
  })

  it('reports one unknown field warning per unrecognised key', () => {
    expect(codesOf({ text: 'name: review\ndescription: a\nhooks: x\nfuture: y' })).toEqual([
      ESkillWarning.UnknownField,
      ESkillWarning.UnknownField,
    ])
  })

  it('carries a readable detail on every warning', () => {
    const warnings = validateSkill({
      frontmatter: skillFrontmatterOf({
        document: parseYaml('name: Bad_Name\ndescription: a'),
        fallbackName: '',
      }),
      directoryName: 'bad-name',
    })

    expect(warnings.length).toBeGreaterThan(0)
    for (const warning of warnings) expect(warning.detail.length).toBeGreaterThan(0)
  })
})
