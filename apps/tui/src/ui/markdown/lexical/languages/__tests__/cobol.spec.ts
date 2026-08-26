import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { cobol as spec } from '../cobol'

const source = [
  '      *> a calculator',
  '      * the asterisk above sits in column seven',
  '       IDENTIFICATION DIVISION.',
  '       PROGRAM-ID. CALCULATOR.',
  '       AUTHOR. ATLAS.',
  '',
  '       DATA DIVISION.',
  '       WORKING-STORAGE SECTION.',
  '       01  WS-LEFT      PIC S9(4) COMP-3 VALUE 6.',
  '       01  WS-RIGHT     PIC S9(4) COMP-3 VALUE 7.',
  '       01  WS-RESULT    PIC S9(8) VALUE ZERO.',
  "       01  WS-LABEL     PIC X(12) VALUE 'product is '.",
  "       01  WS-DONE      PIC X     VALUE 'N'.",
  "           88  RUN-DONE           VALUE 'Y'.",
  '       01  WS-DATA-RECORD.',
  '           05  WS-DATA-KEY  PIC X(4)  VALUE SPACES.',
  '           05  WS-DATA-TEXT PIC X(20) VALUE SPACES.',
  '',
  '      /  the procedure division follows',
  '       PROCEDURE DIVISION.',
  '       MAIN-PARAGRAPH.',
  '           PERFORM ADD-VALUES',
  '           PERFORM MULTIPLY-VALUES',
  '           PERFORM DISPLAY-RESULT',
  '           SET RUN-DONE TO TRUE',
  '           STOP RUN. *> nothing follows',
  '',
  '       ADD-VALUES.',
  '           ADD WS-LEFT TO WS-RIGHT GIVING WS-RESULT.',
  '',
  '       MULTIPLY-VALUES.',
  '           COMPUTE WS-RESULT = WS-LEFT * WS-RIGHT',
  '           END-COMPUTE.',
  '',
  '       DISPLAY-RESULT.',
  '           IF WS-RESULT > ZERO',
  '               DISPLAY WS-LABEL WS-RESULT',
  '           ELSE',
  '               DISPLAY "no product to show"',
  '           END-IF.',
  '',
  '       END PROGRAM CALCULATOR.',
  '',
].join('\n')

describe('cobol lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: ['comment', 'keyword', 'string', 'number', 'constant.builtin', 'boolean', 'operator'],
    })
  })

  it('reads every column-seven indicator as a comment', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '*> a calculator',
      '* the asterisk above sits in column seven',
      '/  the procedure division follows',
      '*> nothing follows',
    ])
  })

  it('leaves an asterisk outside column seven as multiplication', () => {
    const line = '           COMPUTE WS-RESULT = WS-LEFT * WS-RIGHT'
    expect(groupsIn({ spec, source: line })).not.toContain('comment')
    expect(textFor({ spec, source: line, group: 'operator' })).toEqual(['=', '*'])
  })

  it('leaves a slash outside column seven as division', () => {
    const line = '           COMPUTE WS-MEAN = WS-RESULT / WS-RIGHT'
    expect(groupsIn({ spec, source: line })).not.toContain('comment')
    expect(textFor({ spec, source: line, group: 'operator' })).toEqual(['=', '/'])
  })

  it('reads a hyphenated reserved word as one keyword', () => {
    expect(textFor({ spec, source: '       WORKING-STORAGE SECTION.', group: 'keyword' })).toEqual([
      'WORKING-STORAGE',
      'SECTION',
    ])
  })

  it('folds keyword case', () => {
    expect(textFor({ spec, source: '       procedure division.', group: 'keyword' })).toEqual([
      'procedure',
      'division',
    ])
  })

  it('reads both quote forms, and a doubled quote as one literal', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      "'product is '",
      "'N'",
      "'Y'",
      '"no product to show"',
    ])
    expect(textFor({ spec, source: "           DISPLAY 'it''s done'", group: 'string' })).toEqual([
      "'it''s done'",
    ])
  })

  it('reads a figurative constant as a builtin constant', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual([
      'ZERO',
      'SPACES',
      'SPACES',
      'ZERO',
    ])
  })

  it('reads a level number as a number', () => {
    expect(textFor({ spec, source: '       01  WS-TOTAL PIC X(5).', group: 'number' })).toEqual([
      '01',
      '5',
    ])
  })

  it('reads the go-to and file-description words', () => {
    expect(textFor({ spec, source: '           GO TO MAIN-EXIT.', group: 'keyword' })).toEqual([
      'GO',
      'TO',
    ])
    expect(textFor({ spec, source: '       FD  CUSTOMER-FILE.', group: 'keyword' })).toEqual(['FD'])
  })

  it('leaves a paragraph name that embeds a verb alone', () => {
    expectPlain({ spec, source, text: 'DISPLAY-RESULT' })
  })

  it('leaves a data name built from reserved words alone', () => {
    expectPlain({ spec, source, text: 'WS-DATA-RECORD' })
    expectPlain({ spec, source, text: 'WS-DATA-KEY' })
  })

  it('answers to the cbl and cob aliases too', () => {
    expect(spec.aliases).toContain('cbl')
    expect(spec.aliases).toContain('cob')
  })
})
