import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { scss as spec } from '../scss'

const source = [
  '// theme tokens',
  '@use "sass:math";',
  '',
  '$greeting: "Hello, World!";',
  '$scale: 1.5;',
  '$brand: #3f8ecc;',
  '',
  '@mixin card($radius: 4px) {',
  '  border-radius: $radius;',
  '  padding: math.div(16px, 2);',
  '}',
  '',
  '@function multiply($x, $y) {',
  '  @if $x == null or $y == null {',
  '    @return 0;',
  '  }',
  '  @return $x * $y;',
  '}',
  '',
  '/* the card itself */',
  '.card {',
  '  @include card(8px);',
  '  color: $brand;',
  '  background: url(https://cdn.example.com/card.png) no-repeat;',
  '  margin: 0 auto;',
  '  max-width: 100%;',
  '  width: multiply(20px, $scale);',
  '',
  '  &:focus {',
  '    outline: 2px solid $brand;',
  '  }',
  '',
  '  &--wide {',
  '    max-width: none;',
  '  }',
  '}',
  '',
  '::-webkit-scrollbar {',
  '  width: 6px;',
  '}',
  '',
  '#app .card:hover {',
  '  background: transparent !important;',
  '}',
  '',
  'body::before {',
  '    content: $greeting;',
  '}',
  '',
  '%pill {',
  '  border: 1px solid currentColor;',
  '}',
  '',
  '@each $name in (small, large) {',
  '  .icon-#{$name} {',
  '    display: none;',
  '  }',
  '}',
  '',
  '@media (min-width: 48rem) {',
  '  h1, h2 {',
  '    line-height: 1.25;',
  '  }',
  '}',
  '',
].join('\n')

describe('scss lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'variable',
        'keyword.directive',
        'keyword',
        'property',
        'type',
        'tag',
        'attribute',
        'constant',
        'constant.builtin',
        'number',
        'function.call',
        'operator',
        'punctuation.special',
      ],
    })
  })

  it('reads a dollar-led name as a variable, declared and referenced', () => {
    expect(textFor({ spec, source: '$greeting: "Hello!";\ncontent: $greeting;', group: 'variable' })).toEqual([
      '$greeting',
      '$greeting',
    ])
  })

  it('keeps a variable declaration a variable rather than a property', () => {
    expect(groupsIn({ spec, source: '$font-size: 14px;' })).toEqual(new Set(['variable', 'number']))
  })

  it('reads a property name up to the colon', () => {
    expect(textFor({ spec, source: '.card {\n  border-radius: 4px;\n}', group: 'property' })).toEqual([
      'border-radius',
    ])
  })

  it('reads an element selector as a tag and its pseudo-element as an attribute', () => {
    expect(textFor({ spec, source, group: 'tag' })).toEqual(['body', 'h1', 'h2'])
    expect(textFor({ spec, source: 'body::before {\n  content: "x";\n}', group: 'attribute' })).toEqual([
      '::before',
    ])
  })

  it('reads class, id and placeholder selectors as types', () => {
    expect(textFor({ spec, source: '#app .card:hover {\n  color: red;\n}\n%pill {\n  top: 0;\n}', group: 'type' })).toEqual([
      '#app',
      '.card',
      '%pill',
    ])
  })

  it('reads a hex colour as a constant rather than an id selector', () => {
    expect(textFor({ spec, source: '$brand: #3f8ecc;\n#app {\n  color: #fff;\n}', group: 'constant' })).toEqual([
      '#3f8ecc',
      '#fff',
    ])
  })

  it('reads at-rules as directives', () => {
    expect(textFor({ spec, source: '@use "sass:math";\n@mixin card {\n  @include other;\n}', group: 'keyword.directive' })).toEqual([
      '@use',
      '@mixin',
      '@include',
    ])
  })

  it('keeps a number and its unit in one token', () => {
    expect(textFor({ spec, source: 'margin: 0 auto;\npadding: 1.5rem 100% 48px;', group: 'number' })).toEqual([
      '0',
      '1.5rem',
      '100%',
      '48px',
    ])
  })

  it('opens an interpolation as punctuation and lexes what is inside it', () => {
    const interpolated = '.icon-#{$name} {\n  display: none;\n}'
    expect(textFor({ spec, source: interpolated, group: 'punctuation.special' })).toEqual(['#{'])
    expect(textFor({ spec, source: interpolated, group: 'variable' })).toEqual(['$name'])
  })

  it('reads the parent selector as an operator', () => {
    expect(textFor({ spec, source: '.card {\n  &:focus {\n    top: 0;\n  }\n}', group: 'operator' })).toEqual([
      '&',
    ])
  })

  it('leaves a module-qualified call name alone instead of reading it as a class', () => {
    expect(textFor({ spec, source: 'padding: math.div(16px, 2);', group: 'type' })).toEqual([])
    expect(textFor({ spec, source: 'padding: math.div(16px, 2);', group: 'function.call' })).toEqual([
      'div',
    ])
  })

  it('reads an unquoted url as a string instead of opening a line comment', () => {
    const line = 'background: url(https://cdn.example.com/card.png) no-repeat;'
    expect(textFor({ spec, source: line, group: 'string' })).toEqual([
      'https://cdn.example.com/card.png',
    ])
    expect(textFor({ spec, source: line, group: 'property' })).toEqual(['background'])
    expect(groupsIn({ spec, source: line }).has('comment')).toBe(false)
  })

  it('reads a protocol-relative url as a string instead of a line comment', () => {
    const line = '@import url(//fonts.example.com/css?family=Inter);'
    expect(textFor({ spec, source: line, group: 'string' })).toEqual([
      '//fonts.example.com/css?family=Inter',
    ])
    expect(groupsIn({ spec, source: line }).has('comment')).toBe(false)
  })

  it('keeps a url written inside a comment part of that comment', () => {
    const commented = '// see https://sass-lang.com/guide\n.a {\n  top: 0;\n}'
    expect(textFor({ spec, source: commented, group: 'comment' })).toEqual([
      '// see https://sass-lang.com/guide',
    ])
    expect(textFor({ spec, source: commented, group: 'string' })).toEqual([])
  })

  it('reads a vendor-prefixed pseudo-element as an attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual([
      ':focus',
      '::-webkit-scrollbar',
      ':hover',
      '::before',
    ])
  })

  it('keeps the parent selector one token when a bem modifier follows it', () => {
    const bem = '.btn {\n  &--wide {\n    top: 0;\n  }\n}'
    expect(textFor({ spec, source: bem, group: 'operator' })).toEqual(['&'])
    expectPlain({ spec, source: bem, text: '--wide' })
  })

  it('reads the @use alias and the word after @else as keywords', () => {
    expect(
      textFor({ spec, source: '@use "sass:math" as math;\n@if $a {\n} @else if $b {\n}', group: 'keyword' }),
    ).toEqual(['as', 'if'])
  })

  it('leaves an ordinary value word uncoloured', () => {
    expectPlain({ spec, source, text: 'solid $brand' })
    expectPlain({ spec, source, text: 'no-repeat' })
  })

  it('does not claim css, which has a real grammar', () => {
    expect(spec.aliases).toEqual([])
  })
})
