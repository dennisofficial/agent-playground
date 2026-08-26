import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { objc as spec } from '../objc'

const source = [
  '// a calculator',
  '#import <Foundation/Foundation.h>',
  '#import "Calculator.h"',
  '',
  'static NSInteger add(NSInteger x, NSInteger y) {',
  '    return x + y;',
  '}',
  '',
  '@interface Calculator : NSObject',
  '',
  '@property (nonatomic, readonly) NSInteger scale;',
  '',
  '- (instancetype)initWithScale:(NSInteger)scale;',
  '- (NSInteger)multiply:(NSInteger)x by:(NSInteger)y;',
  '',
  '@end',
  '',
  '@implementation Calculator',
  '',
  '- (instancetype)initWithScale:(NSInteger)scale {',
  '    self = [super init];',
  '    if (self == nil) {',
  '        return nil;',
  '    }',
  '    _scale = scale;',
  '    return self;',
  '}',
  '',
  '- (NSInteger)multiply:(NSInteger)x by:(NSInteger)y {',
  '    BOOL valid = x > 0 ? YES : NO;',
  '    if (!valid) {',
  '        return 0;',
  '    }',
  '    return add(x * y, 0) * self.scale;',
  '}',
  '',
  '@end',
  '',
  'int main(void) {',
  '    @autoreleasepool {',
  '        Calculator *calc = [[Calculator alloc] initWithScale:2];',
  '        NSString *label = @"product";',
  "        char tag = 'p';",
  '        NSLog(@"%@%c = %ld", label, tag, (long)[calc multiply:5 by:3]);',
  '        SEL chosen = @selector(multiply:by:);',
  '        if ([calc respondsToSelector:chosen]) {',
  '            printf("done\\n");',
  '        }',
  '    }',
  '    return 0;',
  '}',
  '',
].join('\n')

describe('objc lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'keyword.directive',
        'string',
        'character',
        'keyword',
        'type',
        'type.qualifier',
        'storageclass',
        'constant.builtin',
        'function.builtin',
        'function.call',
        'number',
        'operator',
      ],
    })
  })

  it('reads the at-words as keywords', () => {
    expect(textFor({ spec, source, group: 'keyword' })).toEqual([
      'return',
      '@interface',
      '@property',
      '@end',
      '@implementation',
      'if',
      'return',
      'return',
      'if',
      'return',
      'return',
      '@end',
      '@autoreleasepool',
      '@selector',
      'if',
      'return',
    ])
  })

  it('reads an at-string as a string, alongside the include path', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '<Foundation/Foundation.h>',
      '"Calculator.h"',
      '@"product"',
      '@"%@%c = %ld"',
      '"done\\n"',
    ])
  })

  it('reads nil, YES and NO as builtin constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual([
      'self',
      'super',
      'self',
      'nil',
      'nil',
      'self',
      'YES',
      'NO',
      'self',
    ])
  })

  it('reads NSLog as a builtin rather than a type', () => {
    expect(textFor({ spec, source, group: 'function.builtin' })).toEqual(['NSLog'])
  })

  it('reads a char literal as a character', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'p'"])
  })

  it('reads NSString-style names as types', () => {
    expect(textFor({ spec, source: 'NSString *label = @"x";', group: 'type' })).toEqual(['NSString'])
  })

  it('leaves a message-send name alone', () => {
    expectPlain({ spec, source, text: 'alloc]' })
  })

  it('keeps an at-keyword from swallowing a longer word', () => {
    expect(textFor({ spec, source: '@endless mess', group: 'keyword' })).toEqual([])
    expect(groupsIn({ spec, source: '@endless mess' })).not.toContain('keyword')
  })

  it('does not read a comparison as an include path', () => {
    expectPlain({ spec, source: 'BOOL ok = width < height;', text: 'height' })
  })

  it('leaves a stray apostrophe in directive prose alone', () => {
    const prose = "#pragma mark - Don't stop"
    expectPlain({ spec, source: prose, text: "'t stop" })
    expect(groupsIn({ spec, source: prose })).not.toContain('character')
  })

  it('reads a multi-character code as one character literal', () => {
    expect(textFor({ spec, source: "OSType kind = 'moov';", group: 'character' })).toEqual([
      "'moov'",
    ])
  })

  it('reads an uppercase C function as a call rather than a type', () => {
    const make = 'CGRect box = CGRectMake(0, 0, 10, 10);'
    expect(textFor({ spec, source: make, group: 'function.call' })).toEqual(['CGRectMake'])
    expect(textFor({ spec, source: make, group: 'type' })).toEqual(['CGRect'])
  })

  it('keeps a type sitting before a spaced paren a type', () => {
    const pointer = 'NSInteger (*apply)(NSInteger) = &add;'
    expect(textFor({ spec, source: pointer, group: 'type' })).toEqual(['NSInteger', 'NSInteger'])
    expect(groupsIn({ spec, source: pointer })).not.toContain('function.call')
  })

  it('answers to its long-form aliases', () => {
    expect(spec.aliases).toEqual(['objectivec', 'objective-c'])
  })
})
