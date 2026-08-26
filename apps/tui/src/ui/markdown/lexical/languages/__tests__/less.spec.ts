import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { less as spec } from '../less'

const source = [
  '// design tokens',
  '@greeting: "Hello, World!";',
  '@base-size: 16px;',
  '@page-gutter: 24px;',
  '@brand: #3a7afe;',
  '@gutter-name: ~"gutter-left";',
  '@name: brand;',
  '',
  '@import (reference) "mixins.less";',
  '',
  '/* a guarded mixin */',
  '.scale(@factor) when (@factor > 0) {',
  '    font-size: (@base-size * @factor);',
  '    line-height: 1.5;',
  '}',
  '',
  '@media screen and (min-width: 768px) {',
  '    #app {',
  '        padding: 0 @page-gutter;',
  '        color: @@name;',
  '    }',
  '}',
  '',
  'body::before {',
  '    content: @greeting;',
  '}',
  '',
  'a.link:hover,',
  '.card:not(.is-disabled) {',
  '    .scale(1.25);',
  '    color: darken(@brand, 10%);',
  '    border: 1px solid transparent;',
  '    background: none !important;',
  '',
  '    &:focus-visible {',
  '        outline: -2px auto @brand;',
  '    }',
  '}',
  '',
  '.@{gutter-name} {',
  '    margin-left: 50%;',
  '}',
  '',
].join('\n')

describe('less lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'string.escape',
        'keyword.directive',
        'variable',
        'constant',
        'constant.builtin',
        'type',
        'tag',
        'property',
        'attribute',
        'number',
        'keyword',
        'function.call',
        'operator',
      ],
    })
  })

  it('separates an at-rule from an at-led variable', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual(['@import', '@media'])
    expect(textFor({ spec, source, group: 'variable' })).toContain('@greeting')
    expect(textFor({ spec, source, group: 'variable' })).toContain('@page-gutter')
  })

  it('reads the variable-variable and interpolation forms', () => {
    const variables = textFor({ spec, source, group: 'variable' })
    expect(variables).toContain('@@name')
    expect(variables).toContain('@{gutter-name}')
  })

  it('reads an escaped value as a string', () => {
    expect(textFor({ spec, source, group: 'string.escape' })).toEqual(['~"gutter-left"'])
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"Hello, World!"',
      '"mixins.less"',
    ])
  })

  it('reads a hex colour as a constant and a hash-led selector as a type', () => {
    expect(textFor({ spec, source, group: 'constant' })).toEqual(['#3a7afe'])
    expect(textFor({ spec, source, group: 'type' })).toEqual([
      '.scale',
      '#app',
      '.link',
      '.card',
      '.is-disabled',
      '.scale',
    ])
  })

  it('reads element selectors as tags and pseudo selectors as attributes', () => {
    expect(textFor({ spec, source, group: 'tag' })).toEqual(['body', 'a'])
    expect(textFor({ spec, source, group: 'attribute' })).toEqual([
      '::before',
      ':hover',
      ':not',
      ':focus-visible',
    ])
  })

  it('reads property names and numbers with units', () => {
    expect(textFor({ spec, source, group: 'property' })).toEqual([
      'font-size',
      'line-height',
      'min-width',
      'padding',
      'color',
      'content',
      'color',
      'border',
      'background',
      'outline',
      'margin-left',
    ])
    expect(textFor({ spec, source, group: 'number' })).toEqual([
      '16px',
      '24px',
      '0',
      '1.5',
      '768px',
      '0',
      '1.25',
      '10%',
      '1px',
      '-2px',
      '50%',
    ])
  })

  it('reads guards, bangs and value keywords', () => {
    expect(textFor({ spec, source, group: 'keyword' })).toEqual(['when', 'and', '!important'])
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual([
      'transparent',
      'none',
      'auto',
    ])
  })

  it('reads a mixin function as a call', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual(['darken'])
  })

  it('lexes the reported snippet the way a reader would read it', () => {
    const snippet = [
      '@greeting: "Hello, World!";',
      'body::before {',
      '    content: @greeting;',
      '}',
    ].join('\n')
    expect([...groupsIn({ spec, source: snippet })].sort()).toEqual([
      'attribute',
      'property',
      'string',
      'tag',
      'variable',
    ])
    expect(textFor({ spec, source: snippet, group: 'variable' })).toEqual([
      '@greeting',
      '@greeting',
    ])
    expect(textFor({ spec, source: snippet, group: 'string' })).toEqual(['"Hello, World!"'])
    expect(textFor({ spec, source: snippet, group: 'tag' })).toEqual(['body'])
    expect(textFor({ spec, source: snippet, group: 'attribute' })).toEqual(['::before'])
    expect(textFor({ spec, source: snippet, group: 'property' })).toEqual(['content'])
  })

  it('reads an at-led name that merely starts like an at-rule as a variable', () => {
    const names = '@medium: 900px;\n@pages: 3;\n@media-max: 600px;\n@rest-arg: 1;'
    expect(textFor({ spec, source: names, group: 'keyword.directive' })).toEqual([])
    expect(textFor({ spec, source: names, group: 'variable' })).toEqual([
      '@medium',
      '@pages',
      '@media-max',
      '@rest-arg',
    ])
  })

  it('keeps an unquoted url out of the comment, tag and class rules', () => {
    const url = 'a { background: url(//cdn.example.com/logo.png) no-repeat; }'
    expect(textFor({ spec, source: url, group: 'comment' })).toEqual([])
    expect(textFor({ spec, source: url, group: 'string' })).toEqual(['//cdn.example.com/logo.png'])
    expect(textFor({ spec, source: url, group: 'function.call' })).toEqual(['url'])
    expectPlain({ spec, source: url, text: 'no-repeat' })
  })

  it('leaves the arguments of a mixin whose name ends in url alone', () => {
    const mixin = '.image-url(@path) { background: url("@{path}"); }'
    expect(textFor({ spec, source: mixin, group: 'variable' })).toEqual(['@path'])
    expect(textFor({ spec, source: mixin, group: 'string' })).toEqual(['"@{path}"'])
  })

  it('does not read a quoted comment opener as a comment', () => {
    const quoted = '.t { content: "// not a comment"; }'
    expect(textFor({ spec, source: quoted, group: 'comment' })).toEqual([])
    expect(textFor({ spec, source: quoted, group: 'string' })).toEqual(['"// not a comment"'])
  })

  it('reads a guard comparison as an operator', () => {
    const guard = '.m() when (@a < 10) and (@b =< 2) { top: 0; }'
    expect(textFor({ spec, source: guard, group: 'operator' })).toEqual(['<', '=<'])
  })

  it('leaves a bare value word alone', () => {
    expectPlain({ spec, source, text: 'solid' })
    expectPlain({ spec, source, text: 'screen' })
    expectPlain({ spec, source, text: 'brand;' })
  })
})
