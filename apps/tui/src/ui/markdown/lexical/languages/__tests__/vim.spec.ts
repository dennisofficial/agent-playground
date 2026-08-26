import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { vim as spec } from '../vim'

const source = [
  '" a calculator',
  'scriptencoding utf-8',
  '',
  'function! s:add(x, y) abort',
  '  return a:x + a:y',
  'endfunction',
  '',
  'let g:Calculator = {}',
  '',
  'function! g:Calculator.multiply(x, y) dict',
  '  if a:x == 0 || a:y == 0',
  '    return 0',
  '  endif',
  '  return a:x * a:y',
  'endfunction',
  '',
  'let g:scale = 2',
  'echo s:add(2, 3)',
  "echom printf('It''s %d', g:Calculator.multiply(5, 3) * g:scale)",
  '',
  "if &filetype ==# 'vim'",
  '  setlocal expandtab',
  'endif',
  '',
  'augroup atlas_calc',
  '  autocmd!',
  '  autocmd BufWritePre *.vim call s:add(1, 1)',
  'augroup END',
  '',
  'nnoremap <silent> <leader>m :call <SID>add(1, 2)<CR>',
  "xnoremap <leader>r :'<,'>retab<CR>",
  '',
  'let @" = getline(1)',
  '',
].join('\n')

describe('vim lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'variable',
        'variable.builtin',
        'constant',
        'function.call',
        'function.builtin',
        'character',
        'number',
        'operator',
      ],
    })
  })

  it('reads a leading double quote as a comment and a later one as a string', () => {
    const dual = ['echo "hi"', '" not code', '  " indented is still a comment'].join('\n')
    expect(textFor({ spec, source: dual, group: 'string' })).toEqual(['"hi"'])
    expect(textFor({ spec, source: dual, group: 'comment' })).toEqual([
      '" not code',
      '" indented is still a comment',
    ])
  })

  it('reads every scope prefix as one variable', () => {
    const scopes = 'let g:a = a:b . s:c . l:d . b:e . w:f . t:g . v:count'
    expect(textFor({ spec, source: scopes, group: 'variable' })).toEqual([
      'g:a',
      'a:b',
      's:c',
      'l:d',
      'b:e',
      'w:f',
      't:g',
      'v:count',
    ])
  })

  it('reads an ampersand option and a register as builtin variables', () => {
    expect(textFor({ spec, source, group: 'variable.builtin' })).toEqual(['&filetype', '@"'])
  })

  it('keeps the quote register from opening a string', () => {
    const yanked = 'let @" = @a . @+'
    expect(textFor({ spec, source: yanked, group: 'string' })).toEqual([])
    expect(textFor({ spec, source: yanked, group: 'variable.builtin' })).toEqual(['@"', '@a', '@+'])
  })

  it('leaves a syntax cluster reference uncoloured rather than reading one letter of it', () => {
    const cluster = 'syntax region atlasBody start=+{+ end=+}+ contains=@atlasTop'
    expectPlain({ spec, source: cluster, text: 'atlasTop' })
  })

  it('reads a visual line range as a constant, not as a string', () => {
    expect(textFor({ spec, source, group: 'constant' })).toEqual(["'<,'>"])
    expect(textFor({ spec, source, group: 'string' })).toEqual(["'It''s %d'", "'vim'"])
  })

  it('still reads a lone angle bracket in quotes as a string', () => {
    const split = "let parts = split(line, '>')"
    expect(textFor({ spec, source: split, group: 'string' })).toEqual(["'>'"])
    expect([...groupsIn({ spec, source: split })]).not.toContain('constant')
  })

  it('reads a keycode whole, ahead of the keyword inside it', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual([
      '<silent>',
      '<leader>',
      '<SID>',
      '<CR>',
      '<leader>',
      '<CR>',
    ])
  })

  it('leaves a command bang standing beside its keyword', () => {
    const banged = 'function! s:f()\nendfunction'
    expect(textFor({ spec, source: banged, group: 'keyword' })).toEqual([
      'function',
      'endfunction',
    ])
    expect(textFor({ spec, source: banged, group: 'operator' })).toEqual(['!'])
  })

  it('reads a dict method and a SID call as calls', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual([
      'multiply',
      'multiply',
      'add',
    ])
  })

  it('reads an autoload name as one call', () => {
    expect(textFor({ spec, source: "call atlas#core#boot('x')", group: 'function.call' })).toEqual([
      'atlas#core#boot',
    ])
  })

  it('leaves a function attribute alone', () => {
    expectPlain({ spec, source, text: 'abort' })
  })

  it('leaves an autocmd event alone', () => {
    expectPlain({ spec, source, text: 'BufWritePre' })
  })

  it('does not read a comparison as a keycode', () => {
    const compared = 'if a:x < a:y && a:x <= 1'
    expect([...groupsIn({ spec, source: compared })]).not.toContain('character')
    expect(textFor({ spec, source: compared, group: 'operator' })).toEqual(['<', '&&', '<='])
  })

  it('answers to the vimrc alias too', () => {
    expect(spec.aliases).toContain('vimrc')
  })
})
