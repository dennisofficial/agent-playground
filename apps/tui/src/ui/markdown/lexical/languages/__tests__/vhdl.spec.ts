import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { vhdl as spec } from '../vhdl'

const source = [
  '-- a calculator package',
  'library ieee;',
  'use ieee.std_logic_1164.all;',
  'use ieee.numeric_std.all;',
  '',
  'package calculator is',
  '  constant scale : integer := 2;',
  '  constant mask  : integer := 16#FF#;',
  '  constant debug : boolean := false;',
  '  function add(x : integer; y : integer) return integer;',
  '  function multiply(x : integer; y : integer) return integer;',
  'end package calculator;',
  '',
  'package body calculator is',
  '',
  '  function add(x : integer; y : integer) return integer is',
  '  begin',
  '    return x + y;',
  '  end function add;',
  '',
  '  function multiply(x : integer; y : integer) return integer is',
  '    variable total : integer := 0;',
  '  begin',
  '    for i in 1 to y loop',
  '      total := total + x;',
  '    end loop;',
  '    return total * scale;',
  '  end function multiply;',
  '',
  'end package body calculator;',
  '',
  '/* the device under test */',
  'use work.calculator.all;',
  '',
  'entity demo is',
  '  port (',
  '    clk : in  std_logic;',
  '    q   : out std_logic_vector(7 downto 0)',
  '  );',
  'end entity demo;',
  '',
  'architecture rtl of demo is',
  '  constant blank     : std_logic_vector(7 downto 0) := x"FF";',
  "  signal count      : unsigned(7 downto 0) := (others => '0');",
  '  signal next_count : unsigned(7 downto 0);',
  'begin',
  '',
  '  next_count <= count + 1;',
  '',
  '  tick : process (clk)',
  '  begin',
  "    if clk'event and clk = '1' then",
  '      count <= next_count;',
  '    end if;',
  '  end process tick;',
  '',
  '  banner : process',
  '  begin',
  '    wait until rising_edge(clk);',
  "    report \"sum = \" & integer'image(add(5, 3)) severity note;",
  "    report \"the \"\"product\"\" = \" & integer'image(multiply(5, 3)) severity note;",
  '    wait;',
  '  end process banner;',
  '',
  '  q <= std_logic_vector(count) xor blank;',
  '',
  'end architecture rtl;',
  '',
].join('\n')

describe('vhdl lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'boolean',
        'number',
        'operator',
        'attribute',
        'character',
        'constant.builtin',
        'function.call',
        'function.builtin',
      ],
    })
  })

  it('reads a tick followed by a name as an attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual([
      "'event",
      "'image",
      "'image",
    ])
  })

  it('reads a single-quoted bit as a character, not an attribute', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'0'", "'1'"])
  })

  it('keeps a std_logic value literal out of the attribute group', () => {
    expect(textFor({ spec, source: "d <= 'U';", group: 'attribute' })).toEqual([])
    expect(textFor({ spec, source: "d <= 'U';", group: 'character' })).toEqual(["'U'"])
  })

  it('lets the attribute tick win over the keyword of the same name', () => {
    const attributed = "v := sig'range;"
    expect(textFor({ spec, source: attributed, group: 'attribute' })).toEqual(["'range"])
    expect(textFor({ spec, source: attributed, group: 'keyword' })).toEqual([])
  })

  it('folds keyword case', () => {
    expect(textFor({ spec, source: 'END ARCHITECTURE Rtl;', group: 'keyword' })).toEqual([
      'END',
      'ARCHITECTURE',
    ])
  })

  it('reads both assignment forms as operators', () => {
    expect(textFor({ spec, source: 'a <= b; c := d; e => f;', group: 'operator' })).toEqual([
      '<=',
      ':=',
      '=>',
    ])
  })

  it('reads a matching-relation operator whole', () => {
    expect(textFor({ spec, source: 'if a ?= b then', group: 'operator' })).toEqual(['?='])
  })

  it('reads based and bit-string literals as single numbers', () => {
    expect(textFor({ spec, source, group: 'number' })).toContain('16#FF#')
    expect(textFor({ spec, source, group: 'number' })).toContain('x"FF"')
    expect(textFor({ spec, source: 'c := 10UX"0F";', group: 'number' })).toEqual(['10UX"0F"'])
    expect(textFor({ spec, source: 'c := B"1010_0011";', group: 'number' })).toEqual([
      'B"1010_0011"',
    ])
  })

  it('reads a doubled quotation mark as part of one string', () => {
    expect(
      textFor({ spec, source: 'report "he said ""no""" severity note;', group: 'string' }),
    ).toEqual(['"he said ""no"""'])
  })

  it('does not treat a backslash as a string escape', () => {
    const path = 'file_open(fh, "C:\\logs\\", write_mode);'
    expect(textFor({ spec, source: path, group: 'string' })).toEqual(['"C:\\logs\\"'])
  })

  it('closes a character literal holding a quotation mark before it opens a string', () => {
    const compare = 'if ch = \'"\' then'
    expect(textFor({ spec, source: compare, group: 'character' })).toEqual(['\'"\''])
    expect(textFor({ spec, source: compare, group: 'string' })).toEqual([])
  })

  it('reads a comment to the end of the line only', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '-- a calculator package',
      '/* the device under test */',
    ])
  })

  it('leaves an identifier that merely contains a keyword alone', () => {
    expectPlain({ spec, source, text: 'next_count' })
  })

  it('leaves a physical-literal unit alone', () => {
    expectPlain({ spec, source: 'wait for 10 ns;', text: 'ns' })
  })

  it('answers to the vhd alias too', () => {
    expect(spec.aliases).toContain('vhd')
  })
})
