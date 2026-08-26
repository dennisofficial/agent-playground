import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { verilog as spec } from '../verilog'

const source = [
  '`timescale 1ns / 1ps',
  '`define WIDTH 8',
  '',
  '// an 8-bit calculator with a registered product',
  'module calculator (',
  '    input  wire        clk,',
  '    input  wire [7:0]  a,',
  '    input  wire [7:0]  b,',
  '    output reg  [15:0] product,',
  '    output wire [7:0]  total',
  ');',
  '',
  '  localparam [`WIDTH-1:0] MASK = 8\'b1010_1010;',
  '  reg [31:0] and_result;',
  '',
  '  function [7:0] add(input [7:0] x, input [7:0] y);',
  '    add = x + y;',
  '  endfunction',
  '',
  '  task multiply(input [7:0] x, input [7:0] y);',
  '    begin',
  '      product = x * y;',
  '    end',
  '  endtask',
  '',
  '  assign total = add(a, b) & MASK;',
  '',
  '  always @(posedge clk) begin',
  '    if (and_result == 32\'hDEAD_BEEF) begin',
  '      and_result <= 1\'b0;',
  '    end else begin',
  '      multiply(a, b);',
  '    end',
  '  end',
  '',
  '  initial begin',
  '    $display("total = %0d", total);',
  '    $finish;',
  '  end',
  '',
  'endmodule',
  '',
  'module top (',
  '    input  wire       clk,',
  '    input  wire [7:0] a,',
  '    input  wire [7:0] b',
  ');',
  '',
  '  wire  [7:0] total;',
  '  wire [15:0] product;',
  '',
  '  calculator u_calc (',
  '      .clk     (clk),',
  '      .a       (a),',
  '      .b       (b),',
  '      .product (product),',
  '      .total   (total)',
  '  );',
  '',
  'endmodule',
  '',
].join('\n')

const literals = "assign masked = 8'b1010_1010 ^ 32'hDEAD_BEEF;"

describe('verilog lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'keyword.directive',
        'number',
        'operator',
        'property',
        'function.call',
        'function.builtin',
      ],
    })
  })

  it('reads a sized literal as one number', () => {
    expect(textFor({ spec, source: literals, group: 'number' })).toEqual([
      "8'b1010_1010",
      "32'hDEAD_BEEF",
    ])
  })

  it('never opens a string on the quote of a sized literal', () => {
    expect(groupsIn({ spec, source: literals })).not.toContain('string')
  })

  it('reads an unsized fill literal as a number', () => {
    expect(textFor({ spec, source: "logic [3:0] v = '0;", group: 'number' })).toEqual([
      '3',
      '0',
      "'0",
    ])
  })

  it('reads a backtick form as a compiler directive', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual([
      '`timescale',
      '`define',
      '`WIDTH',
    ])
  })

  it('reads a dollar form as a system task', () => {
    expect(textFor({ spec, source, group: 'function.builtin' })).toEqual(['$display', '$finish'])
  })

  it('reads a named port connection as a property', () => {
    expect(textFor({ spec, source, group: 'property' })).toEqual([
      '.clk',
      '.a',
      '.b',
      '.product',
      '.total',
    ])
  })

  it('never reads the fraction of a real literal as a port', () => {
    const decimal = 'parameter real SCALE = 3.25;'
    expect(textFor({ spec, source: decimal, group: 'number' })).toEqual(['3.25'])
    expect(groupsIn({ spec, source: decimal })).not.toContain('property')
  })

  it('reads the named head of a parenthesised construct as a call', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual([
      'calculator',
      'add',
      'multiply',
      'add',
      'multiply',
      'top',
      'u_calc',
    ])
  })

  it('reads a double-quoted format string as a string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual(['"total = %0d"'])
  })

  it('keeps a control keyword out of the call group', () => {
    expect(textFor({ spec, source: 'foreach (bus[i]) total += bus[i];', group: 'keyword' })).toEqual(
      ['foreach'],
    )
  })

  it('leaves a signal whose name opens with a keyword alone', () => {
    expectPlain({ spec, source, text: 'and_result' })
  })

  it('leaves an upper-case parameter name alone', () => {
    expectPlain({ spec, source, text: 'MASK' })
  })

  it('answers to the systemverilog spellings too', () => {
    expect(spec.aliases).toEqual(['v', 'systemverilog', 'sv'])
  })
})
