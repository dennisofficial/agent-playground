import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { graphql as spec } from '../graphql'

const source = [
  '# the calculator schema and the query that drives it',
  'schema {',
  '  query: Query',
  '  mutation: Mutation',
  '}',
  '',
  '"""',
  'Arithmetic over a pair of integers.',
  '"""',
  'type Calculator implements Node {',
  '  id: ID!',
  '  add(x: Int!, y: Int!): Int!',
  '  multiply(x: Int!, y: Int!): Int!',
  '  precision: Float @deprecated(reason: "always exact")',
  '  name: String',
  '  factors: [Int!]!',
  '}',
  '',
  'interface Node {',
  '  id: ID!',
  '}',
  '',
  'input Pair {',
  '  x: Int! = 0',
  '  y: Int! = 0',
  '}',
  '',
  'enum Rounding {',
  '  UP',
  '  DOWN',
  '}',
  '',
  'scalar Decimal',
  '',
  'type Constant implements Node {',
  '  id: ID!',
  '  value: Float!',
  '}',
  '',
  'union Operand = Calculator | Constant',
  '',
  'type Query {',
  '  calculator(id: ID!): Calculator',
  '  operand(id: ID!): Operand',
  '}',
  '',
  'type Mutation {',
  '  round(pair: Pair!, mode: Rounding!): Decimal!',
  '}',
  '',
  'query Multiply($id: ID!, $x: Int! = 5, $y: Int! = 3, $verbose: Boolean = false) {',
  '  calculator(id: $id) {',
  '    __typename',
  '    ...Totals',
  '    product: multiply(x: $x, y: $y) @include(if: $verbose)',
  '  }',
  '}',
  '',
  'mutation Round($pair: Pair!) {',
  '  round(pair: $pair, mode: UP)',
  '}',
  '',
  'fragment Totals on Calculator {',
  '  add(x: 1, y: 2)',
  '  precision',
  '}',
  '',
].join('\n')

describe('graphql lexical highlighting', () => {
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
        'variable',
        'attribute',
        'punctuation',
        'function.call',
        'number',
        'constant.builtin',
        'operator',
      ],
    })
  })

  it('reads a dollar-led name as a variable', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual([
      '$id',
      '$x',
      '$y',
      '$verbose',
      '$id',
      '$x',
      '$y',
      '$verbose',
      '$pair',
      '$pair',
    ])
  })

  it('reads an at-led name as a directive attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['@deprecated', '@include'])
  })

  it('reads the built-in scalars apart from the user-declared ones', () => {
    const builtins = textFor({ spec, source, group: 'type.builtin' })
    expect([...new Set(builtins)]).toEqual(['ID', 'Int', 'Float', 'String', 'Boolean'])
    expect(builtins).not.toContain('Decimal')
    expect(textFor({ spec, source, group: 'type' })).toContain('Decimal')
  })

  it('reads a colon-led name as a property and a parenthesised one as a call', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual([
      'add',
      'multiply',
      'calculator',
      'operand',
      'round',
      'calculator',
      'multiply',
      'round',
      'add',
    ])
    const properties = textFor({ spec, source, group: 'property' })
    expect(properties).toContain('precision')
    expect(properties).toContain('product')
    expect(properties).toContain('reason')
  })

  it('reads a root-operation field as a property and an operation head as a keyword', () => {
    expect(textFor({ spec, source, group: 'property' }).slice(0, 2)).toEqual(['query', 'mutation'])
    const keywords = textFor({ spec, source, group: 'keyword' })
    expect(keywords).toContain('query')
    expect(keywords).toContain('mutation')
  })

  it('reads a block description and a string argument as strings', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"""\nArithmetic over a pair of integers.\n"""',
      '"always exact"',
    ])
  })

  it('reads the spread of a fragment as punctuation', () => {
    expect(textFor({ spec, source, group: 'punctuation' })).toEqual(['...'])
  })

  it('keeps a block description whole when it escapes a triple quote', () => {
    const inline = ['"""', 'Write \\""" to quote a quote.', '"""', 'scalar Decimal'].join('\n')
    expect(textFor({ spec, source: inline, group: 'string' })).toEqual([
      '"""\nWrite \\""" to quote a quote.\n"""',
    ])
    expect(textFor({ spec, source: inline, group: 'keyword' })).toEqual(['scalar'])
    expect(textFor({ spec, source: inline, group: 'type' })).toEqual(['Decimal'])
  })

  it('leaves a bare selected field alone', () => {
    expectPlain({ spec, source, text: '__typename' })
    expectPlain({ spec, source: '{\n  user {\n    nickname\n  }\n}', text: 'nickname' })
  })

  it('does not read a built-in scalar out of a longer type name', () => {
    const inline = 'type Edge { node: IDToken, cursor: Stringify, weight: Integer }'
    expect(textFor({ spec, source: inline, group: 'type' })).toEqual([
      'Edge',
      'IDToken',
      'Stringify',
      'Integer',
    ])
    expect(textFor({ spec, source: inline, group: 'type.builtin' })).toEqual([])
  })

  it('answers to the gql alias too', () => {
    expect(spec.aliases).toContain('gql')
  })
})
