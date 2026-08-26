import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { perl as spec } from '../perl'

const source = [
  '#!/usr/bin/perl',
  'use strict;',
  'use warnings;',
  'use List::Util qw(sum);',
  '',
  '=pod',
  'Calculator scales a product by a factor given at construction.',
  '=cut',
  '',
  'sub add {',
  '    my @terms = @_;',
  '    my $last  = $#terms;',
  '    return $last < 0 ? 0 : sum(@terms);',
  '}',
  '',
  'package Calculator;',
  '',
  'sub new {',
  '    my ($class, $scale) = @_;',
  '    return bless { scale => $scale }, $class;',
  '}',
  '',
  'sub multiply {',
  '    my ($self, $x, $y) = @_;',
  '    return undef unless defined $x && defined $y;',
  '    return $x * $y * $self->{scale};',
  '}',
  '',
  'package main;',
  '',
  'my %totals = (sum => add(5, 3));',
  'my $product = eval { Calculator->new(2)->multiply(5, 3) } // 0;',
  'warn $@ if $@;',
  '',
  'foreach my $key (sort keys %totals) {',
  '    printf("%-6s %d\\n", $key, $totals{$key});',
  '}',
  "print 'done', \"\\n\";",
  '',
].join('\n')

describe('perl lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'function',
        'function.call',
        'function.builtin',
        'module',
        'type',
        'variable',
        'number',
        'constant.builtin',
        'operator',
      ],
    })
  })

  it('reads every sigil as a variable', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual([
      '@terms',
      '@_',
      '$last',
      '$#terms',
      '$last',
      '@terms',
      '$class',
      '$scale',
      '@_',
      '$scale',
      '$class',
      '$self',
      '$x',
      '$y',
      '@_',
      '$x',
      '$y',
      '$x',
      '$y',
      '$self',
      '%totals',
      '$product',
      '$@',
      '$@',
      '$key',
      '%totals',
      '$key',
      '$totals',
      '$key',
    ])
  })

  it('reads the array-length form and the argument array', () => {
    expect(textFor({ spec, source: 'my $n = $#_ + 1;', group: 'variable' })).toEqual(['$n', '$#_'])
    expect(textFor({ spec, source: 'my ($a, $b) = @_;', group: 'variable' })).toEqual([
      '$a',
      '$b',
      '@_',
    ])
  })

  it('reads a dereferencing sigil together with the reference it unwraps', () => {
    const deref = 'my @all = (@$ref, %$h, $$sref, $#$aref);'
    expect(textFor({ spec, source: deref, group: 'variable' })).toEqual([
      '@all',
      '@$ref',
      '%$h',
      '$$sref',
      '$#$aref',
    ])
  })

  it('reads a package-qualified scalar as one variable', () => {
    expect(textFor({ spec, source: '$Data::Dumper::Indent = 1;', group: 'variable' })).toEqual([
      '$Data::Dumper::Indent',
    ])
  })

  it('reads the punctuation variables', () => {
    const specials = 'my $pid = $$; local $| = 1; my $arg = $0; warn $! if $?;'
    expect(textFor({ spec, source: specials, group: 'variable' })).toEqual([
      '$pid',
      '$$',
      '$|',
      '$arg',
      '$0',
      '$!',
      '$?',
    ])
  })

  it('reads a pod block as one comment', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '#!/usr/bin/perl',
      ['=pod', 'Calculator scales a product by a factor given at construction.', '=cut'].join('\n'),
    ])
  })

  it('reads a pod block opened by a section heading as one comment', () => {
    const doc = ['=head1 NAME', '', 'Calculator - scales a product', '', '=cut', 'sub add { 1 }'].join('\n')
    expect(textFor({ spec, source: doc, group: 'comment' })).toEqual([
      ['=head1 NAME', '', 'Calculator - scales a product', '', '=cut'].join('\n'),
    ])
    expect(textFor({ spec, source: doc, group: 'function' })).toEqual(['add'])
  })

  it('names the declared subs, the imports and the packages', () => {
    expect(textFor({ spec, source, group: 'function' })).toEqual(['add', 'new', 'multiply'])
    expect(textFor({ spec, source, group: 'module' })).toEqual([
      'strict',
      'warnings',
      'List::Util',
      'Calculator',
      'main',
    ])
  })

  it('reads a bareword before an arrow as a class', () => {
    expect(textFor({ spec, source, group: 'type' })).toEqual(['Calculator'])
    expect(textFor({ spec, source: 'My::Calc->new(2)->render;', group: 'type' })).toEqual([
      'My::Calc',
    ])
  })

  it('never reads a chained method name as a class', () => {
    const chain = 'my $out = $obj->format->trim;'
    expect(groupsIn({ spec, source: chain })).not.toContain('type')
    expectPlain({ spec, source: chain, text: 'format' })
  })

  it('keeps an all-caps filehandle a constant rather than a class', () => {
    const flush = 'STDOUT->autoflush(1);'
    expect(textFor({ spec, source: flush, group: 'constant.builtin' })).toEqual(['STDOUT'])
    expect(textFor({ spec, source: '__PACKAGE__->new;', group: 'constant.builtin' })).toEqual([
      '__PACKAGE__',
    ])
  })

  it('reads the quote-word list as a string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      'qw(sum)',
      '"%-6s %d\\n"',
      "'done'",
      '"\\n"',
    ])
  })

  it('reads every quoting delimiter the qw family accepts', () => {
    const forms = 'use POSIX qw/floor/;\nuse base qw[Exporter];\nmy $s = q{hi};\nmy $re = qr(\\d+);'
    expect(textFor({ spec, source: forms, group: 'string' })).toEqual([
      'qw/floor/',
      'qw[Exporter]',
      'q{hi}',
      'qr(\\d+)',
    ])
  })

  it('keeps the percent operator out of the hash sigil', () => {
    expect(textFor({ spec, source: 'my $r = $x % $y;', group: 'variable' })).toEqual([
      '$r',
      '$x',
      '$y',
    ])
    expect(textFor({ spec, source: 'my $r = $x % $y;', group: 'operator' })).toEqual(['=', '%'])
  })

  it('leaves a bareword hash key alone', () => {
    expectPlain({ spec, source, text: 'scale =>' })
    expectPlain({ spec, source: 'my $n = $counts{query};', text: 'query' })
  })

  it('never mistakes a sub name inside a longer word for a declaration', () => {
    expect(groupsIn({ spec, source: 'mysub handler;' })).toEqual(new Set())
  })

  it('answers to the perl5 alias only, leaving pl to prolog and perl6 to raku', () => {
    expect(spec.aliases).toEqual(['perl5'])
  })
})
