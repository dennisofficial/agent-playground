import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { sass as spec } from '../sass'

const reported = ['$greeting: "Hello, World!"', 'body::before', '    content: $greeting'].join('\n')

const source = [
  '// a small theme',
  '@use "sass:math"',
  '',
  '$accent: #3f7fbf',
  '$gutter: 1.5rem',
  "$font-stack: 'Helvetica Neue', sans-serif !default",
  '',
  '/* a loud banner */',
  '',
  '=bordered($width: 1px)',
  '    border: $width solid $accent',
  '    border-radius: 3px',
  '',
  '@mixin padded($amount)',
  '    padding: $amount',
  '',
  '.card',
  '    +bordered(2px)',
  '    @include padded($gutter)',
  '    background: transparent url(http://example.com/bg.png) no-repeat',
  '    font-family: $font-stack',
  '    width: math.div(100%, 3)',
  '    margin: .5em auto',
  '',
  '    &:hover',
  '        border-color: darken($accent, 10%)',
  '',
  '    #main .title',
  '        font-weight: bold',
  '',
  '$greeting: "Hello, World!"',
  'body::before',
  '    content: $greeting',
  '',
  '@each $name in a, b',
  '    .icon-#{$name}',
  '        display: none',
  '',
  '@media (min-width: 40em)',
  '    body',
  '        line-height: 1.4',
  '',
].join('\n')

describe('sass lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'variable',
        'keyword',
        'keyword.directive',
        'function',
        'function.call',
        'property',
        'tag',
        'type',
        'attribute',
        'number',
        'constant',
        'constant.builtin',
        'operator',
      ],
    })
  })

  it('covers the block the user reported as unhighlighted', () => {
    expect(source).toContain(reported)
    expect(textFor({ spec, source: reported, group: 'variable' })).toEqual(['$greeting', '$greeting'])
    expect(textFor({ spec, source: reported, group: 'tag' })).toEqual(['body'])
    expect(textFor({ spec, source: reported, group: 'attribute' })).toEqual(['::before'])
    expect(textFor({ spec, source: reported, group: 'property' })).toEqual(['content'])
    expect(textFor({ spec, source: reported, group: 'string' })).toEqual(['"Hello, World!"'])
  })

  it('reads the indented-syntax mixin shorthands as functions', () => {
    expect(textFor({ spec, source, group: 'function' })).toEqual(['=bordered', '+bordered'])
  })

  it('keeps a hyphenated variable in one token', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual([
      '$accent',
      '$gutter',
      '$font-stack',
      '$width',
      '$width',
      '$accent',
      '$amount',
      '$amount',
      '$gutter',
      '$font-stack',
      '$accent',
      '$greeting',
      '$greeting',
      '$name',
      '$name',
    ])
  })

  it('still colours the minus between two variables', () => {
    const arithmetic = ['.gap', '    width: $outer - $inner'].join('\n')
    expect(textFor({ spec, source: arithmetic, group: 'operator' })).toEqual(['-'])
    expect(textFor({ spec, source: arithmetic, group: 'variable' })).toEqual(['$outer', '$inner'])
  })

  it('ends a semicolon-less property at the newline', () => {
    const declarations = ['.card', '    width: 100%', '    color: red'].join('\n')
    expect(textFor({ spec, source: declarations, group: 'property' })).toEqual(['width', 'color'])
    expect(textFor({ spec, source: declarations, group: 'number' })).toEqual(['100%'])
  })

  it('reads a hex colour ahead of an id selector', () => {
    expect(textFor({ spec, source, group: 'constant' })).toEqual(['#3f7fbf'])
    expect(textFor({ spec, source, group: 'type' })).toEqual(['.card', '#main', '.title', '.icon-'])
  })

  it('falls through to an id selector when the hash is not a colour', () => {
    expect(textFor({ spec, source: '#deadbeef1\n    top: 0', group: 'type' })).toEqual(['#deadbeef1'])
    expect(textFor({ spec, source: '#deadbeef1\n    top: 0', group: 'constant' })).toEqual([])
  })

  it('reads a silent comment and a loud comment alike', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '// a small theme',
      '/* a loud banner */',
    ])
  })

  it('does not read the slashes of a bare url as a comment', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"sass:math"',
      "'Helvetica Neue'",
      'http://example.com/bg.png',
      '"Hello, World!"',
    ])
    expectPlain({ spec, source, text: 'no-repeat' })
  })

  it('reads a namespaced module call as a call, not a class selector', () => {
    const call = ['.grid', '    width: math.div(100%, 3)'].join('\n')
    expect(textFor({ spec, source: call, group: 'function.call' })).toEqual(['div'])
    expect(textFor({ spec, source: call, group: 'type' })).toEqual(['.grid'])
    expectPlain({ spec, source: call, text: 'math' })
  })

  it('reads a compound class selector as two selectors', () => {
    const compound = ['.card.active', '    color: red'].join('\n')
    expect(textFor({ spec, source: compound, group: 'type' })).toEqual(['.card', '.active'])
  })

  it('keeps lengths and their units in one number', () => {
    expect(textFor({ spec, source, group: 'number' })).toEqual([
      '1.5rem',
      '1px',
      '3px',
      '2px',
      '100%',
      '3',
      '.5em',
      '10%',
      '40em',
      '1.4',
    ])
  })

  it('knows the css at-rules alongside the sass ones', () => {
    const atRules = ['@font-face', '    font-family: Foo', '@keyframes spin', '    from', '        opacity: 0'].join('\n')
    expect(textFor({ spec, source: atRules, group: 'keyword.directive' })).toEqual([
      '@font-face',
      '@keyframes',
    ])
  })

  it('leaves a bare value word alone', () => {
    expectPlain({ spec, source, text: 'solid' })
  })

  it('leaves a hyphenated value word whole', () => {
    expectPlain({ spec, source, text: 'sans-serif' })
  })

  it('does not read a spaced sibling combinator as a mixin include', () => {
    const combinator = ['h1', '    + p', '        margin: 0'].join('\n')
    expect(textFor({ spec, source: combinator, group: 'function' })).toEqual([])
    expect(textFor({ spec, source: combinator, group: 'operator' })).toEqual(['+'])
  })
})
