import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { r as spec } from '../r'

const source = [
  '# a calculator, the R way',
  'library(magrittr)',
  '',
  'add <- function(x, y) {',
  '  x + y',
  '}',
  '',
  'Calculator <- list(',
  '  scale = 2L,',
  '  multiply = function(x, y) {',
  '    if (is.na(x) || is.na(y)) {',
  '      return(NA)',
  '    }',
  '    x * y',
  '  }',
  ')',
  '',
  '`answer count` <- 3',
  '',
  'evens <- Filter(function(n) n %% 2 == 0, 1:10)',
  'if (2 %in% evens) {',
  "  cat(sprintf(\"total: %d\\n\", add(2, 3)), sep = '')",
  '}',
  '',
  'grid <- data.frame(x = 1:3, y = c(2, 4, 6))',
  'total <- Calculator$multiply(5, 3)',
  'print(paste0("rows = ", nrow(grid), " total = ", total))',
  'flags <- c(TRUE, FALSE, NaN, Inf)',
  'mid <- stats::median(c(1, 5, 9))',
  'half <- .5 * mid',
  'result <<- total %>% round(digits = 2)',
  'invisible(result) -> ignored',
  '',
].join('\n')

describe('r lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'constant.builtin',
        'function.builtin',
        'function.call',
        'number',
        'operator',
        'variable',
      ],
    })
  })

  it('reads the assignment arrows as operators', () => {
    expect(textFor({ spec, source: 'a <- 1\nb <<- 2\n3 -> d\n4 ->> e', group: 'operator' })).toEqual([
      '<-',
      '<<-',
      '->',
      '->>',
    ])
  })

  it('reads the percent-delimited infix forms as operators', () => {
    expect(textFor({ spec, source: 'x %>% y %in% z %% 2 %o% w', group: 'operator' })).toEqual([
      '%>%',
      '%in%',
      '%%',
      '%o%',
    ])
  })

  it('keeps a dotted name as one identifier', () => {
    const builtins = textFor({ spec, source, group: 'function.builtin' })
    expect(builtins).toContain('data.frame')
    expect(builtins).not.toContain('data')
    expect(textFor({ spec, source, group: 'function.call' })).toContain('is.na')
  })

  it('reads every call site', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual([
      'is.na',
      'is.na',
      'Filter',
      'add',
      'multiply',
      'median',
      'round',
      'invisible',
    ])
  })

  it('reads the sequence, namespace and extraction operators', () => {
    expect(
      textFor({ spec, source: 'v <- stats::median(x[1:3]$w)', group: 'operator' }),
    ).toEqual(['<-', '::', ':', '$'])
  })

  it('reads a leading-dot decimal as one number', () => {
    expect(textFor({ spec, source, group: 'number' })).toContain('.5')
    expect(textFor({ spec, source: 'q <- .25e-3', group: 'number' })).toEqual(['.25e-3'])
  })

  it('keeps a dot-prefixed hidden name whole and uncoloured', () => {
    expectPlain({ spec, source: 'eps <- .Machine$double.eps', text: '.Machine' })
    expectPlain({ spec, source: 'f <- function(...) sum(...)', text: '...' })
  })

  it('reads a backquoted non-syntactic name as a variable', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual(['`answer count`'])
  })

  it('reads the uppercase literals as builtin constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual([
      'NA',
      'TRUE',
      'FALSE',
      'NaN',
      'Inf',
    ])
  })

  it('reads an integer literal with its L suffix', () => {
    expect(textFor({ spec, source, group: 'number' })).toContain('2L')
  })

  it('leaves the namespace holder itself alone', () => {
    expectPlain({ spec, source, text: 'stats' })
  })

  it('keeps a percent placeholder inside a string as string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"total: %d\\n"',
      "''",
      '"rows = "',
      '" total = "',
    ])
  })

  it('leaves a capitalised name alone rather than calling it a type', () => {
    expectPlain({ spec, source, text: 'Calculator' })
    expect(groupsIn({ spec, source })).not.toContain('type')
  })

  it('never matches a one-letter constant inside a longer name', () => {
    expectPlain({ spec, source: 'Format <- Tally + 1', text: 'Format' })
    expectPlain({ spec, source: 'Format <- Tally + 1', text: 'Tally' })
  })

  it('answers to the rscript alias too', () => {
    expect(spec.aliases).toContain('rscript')
  })
})
