import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { prisma as spec } from '../prisma'

const source = [
  '// the thread store and everything that hangs off it',
  'datasource db {',
  '  provider = "postgresql"',
  '  url      = env("DATABASE_URL")',
  '}',
  '',
  'generator client {',
  '  provider        = "prisma-client-js"',
  '  previewFeatures = ["relationJoins"]',
  '}',
  '',
  'model Thread {',
  '  id             String   @id @default(cuid())',
  '  title          String?',
  '  head           Int      @default(0)',
  '  createdAt      DateTime @default(now())',
  '  updatedAt      DateTime @updatedAt',
  '  parentThreadId String?  // fork lineage',
  '  forkSeq        Int?',
  '  forkMode       ForkMode @default(COPY)',
  '  slug           String   @unique @db.VarChar(200)',
  '  weight         Decimal  @default(1.5)',
  '  archived       Boolean  @default(false)',
  '  metadata       Json?',
  '  digest         Bytes?',
  '  rows           Row[]',
  '  parent         Thread?  @relation("lineage", fields: [parentThreadId], references: [id])',
  '  children       Thread[] @relation("lineage")',
  '  @@index([updatedAt])',
  '}',
  '',
  'model Row {',
  '  id       BigInt @id @default(autoincrement())',
  '  threadId String',
  '  thread   Thread @relation(fields: [threadId], references: [id])',
  '  @@unique([threadId, id])',
  '}',
  '',
  'enum ForkMode {',
  '  COPY',
  '  REWIND',
  '  DETACH',
  '}',
  '',
  'type Address {',
  '  street String',
  '  city   String',
  '}',
  '',
].join('\n')

describe('prisma lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'type.builtin',
        'property',
        'attribute',
        'constant',
        'constant.builtin',
        'punctuation',
        'function.call',
        'number',
        'operator',
      ],
    })
  })

  it('reads a block head as a keyword', () => {
    const keywords = textFor({ spec, source, group: 'keyword' })
    expect(keywords).toEqual(['datasource', 'generator', 'model', 'model', 'enum', 'type'])
  })

  it('reads a field attribute and a block attribute alike', () => {
    const attributes = textFor({ spec, source, group: 'attribute' })
    expect(attributes).toContain('@id')
    expect(attributes).toContain('@updatedAt')
    expect(attributes).toContain('@@index')
    expect(attributes).toContain('@@unique')
  })

  it('keeps a native type qualifier attached to its attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toContain('@db.VarChar')
  })

  it('reads the scalar types apart from the declared ones', () => {
    const builtins = new Set(textFor({ spec, source, group: 'type.builtin' }))
    expect([...builtins].sort()).toEqual([
      'BigInt',
      'Boolean',
      'Bytes',
      'DateTime',
      'Decimal',
      'Int',
      'Json',
      'String',
    ])
    const types = textFor({ spec, source, group: 'type' })
    expect(types).toContain('Thread')
    expect(types).toContain('ForkMode')
    expect(types).toContain('Address')
    expect(types).not.toContain('String')
  })

  it('does not read a scalar out of a longer type name', () => {
    const inline = 'model Edge {\n  a Integer\n  b Stringify\n  c JsonDoc\n}'
    expect(textFor({ spec, source: inline, group: 'type.builtin' })).toEqual([])
    expect(textFor({ spec, source: inline, group: 'type' })).toEqual([
      'Edge',
      'Integer',
      'Stringify',
      'JsonDoc',
    ])
  })

  it('names the datasource and generator block', () => {
    expect(textFor({ spec, source, group: 'type' }).slice(0, 2)).toEqual(['db', 'client'])
  })

  it('reads a field name as a property', () => {
    const properties = textFor({ spec, source, group: 'property' })
    expect(properties).toContain('parentThreadId')
    expect(properties).toContain('previewFeatures')
    expect(properties).toContain('fields')
    expect(properties).toContain('references')
  })

  it('reads a field reference inside an attribute argument list as a property', () => {
    const inline = 'model Row {\n  @@unique([threadId, id])\n}'
    expect(textFor({ spec, source: inline, group: 'property' })).toEqual(['threadId', 'id'])
  })

  it('reads a screaming enum member as a constant', () => {
    expect(textFor({ spec, source, group: 'constant' })).toEqual(['COPY', 'REWIND', 'DETACH'])
  })

  it('reads a generator call as a call', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual([
      'env',
      'cuid',
      'now',
      'autoincrement',
    ])
  })

  it('reads the optional and list modifiers as punctuation', () => {
    const punctuation = textFor({ spec, source, group: 'punctuation' })
    expect(new Set(punctuation)).toEqual(new Set(['?', '[]']))
    expect(punctuation.filter((mark) => mark === '[]').length).toBe(2)
  })

  it('reads a trailing line comment without swallowing the field before it', () => {
    const inline = 'model Thread {\n  parentThreadId String? // fork lineage\n}'
    expect(textFor({ spec, source: inline, group: 'comment' })).toEqual(['// fork lineage'])
    expect(textFor({ spec, source: inline, group: 'property' })).toEqual(['parentThreadId'])
    expect(textFor({ spec, source: inline, group: 'type.builtin' })).toEqual(['String'])
  })

  it('reads a doc comment as a comment', () => {
    const inline = 'model Thread {\n  /// the row this thread points at\n  head Int\n}'
    expect(textFor({ spec, source: inline, group: 'comment' })).toEqual([
      '/// the row this thread points at',
    ])
  })

  it('reads a boolean literal as a builtin constant', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['false'])
  })

  it('leaves a relation target name alone inside its brackets', () => {
    expectPlain({ spec, source: 'model Row {\n  id String\n}', text: '{' })
  })
})
