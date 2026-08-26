import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { haskell as spec } from '../haskell'

const source = [
  '{-# LANGUAGE ScopedTypeVariables #-}',
  '-- a calculator',
  '{- a nesting {- inner -} block comment -}',
  'module Calculator (add, multiply, main) where',
  '',
  'import qualified Data.List as List',
  'import Data.Maybe (fromMaybe)',
  '',
  'data Calculator = Calculator { scale :: Int } deriving (Show, Eq)',
  '',
  'add :: Int -> Int -> Int',
  'add x y = x + y',
  '',
  'multiply :: Calculator -> Int -> Int -> Int',
  'multiply calc x y = scale calc * x * y',
  '',
  "initial' :: Calculator",
  "initial' = Calculator { scale = 2 }",
  '',
  'describe :: Calculator -> String',
  'describe calc = "scale=" ++ show (scale calc)',
  '',
  'clamp :: Int -> Int',
  'clamp n',
  '  | n < 0 = 0',
  '  | otherwise = n',
  '',
  'separator :: Char',
  "separator = '\\n'",
  '',
  'main :: IO ()',
  'main = do',
  "  let sums = List.sort [add 2 3, multiply initial' 5 3]",
  '  case sums of',
  '    [] -> putStrLn "empty"',
  '    (s : _) -> print (fromMaybe 0 (Just s))',
  '  putStrLn (describe (Calculator 4))',
  '  putStr [separator]',
  '',
].join('\n')

describe('haskell lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'attribute',
        'comment',
        'keyword',
        'conditional',
        'module',
        'type',
        'string',
        'character',
        'number',
        'operator',
        'function.call',
        'function.builtin',
        'constant.builtin',
      ],
    })
  })

  it('reads a nesting block comment to its outer close', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '-- a calculator',
      '{- a nesting {- inner -} block comment -}',
    ])
  })

  it('reads a pragma as an attribute rather than a comment', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual([
      '{-# LANGUAGE ScopedTypeVariables #-}',
    ])
  })

  it('reads a character literal without swallowing the line', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'\\n'"])
  })

  it('reads dotted and qualifying uppercase names as modules', () => {
    expect(textFor({ spec, source, group: 'module' })).toEqual([
      'Data.List',
      'Data.Maybe',
      'List',
    ])
  })

  it('reads a name applied to a parenthesised argument as a call', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual(['describe'])
  })

  it('reads a signature arrow as one operator token', () => {
    expect(textFor({ spec, source: 'add :: Int -> Int', group: 'operator' })).toEqual(['::', '->'])
  })

  it('leaves a primed name whole and uncoloured', () => {
    expectPlain({ spec, source, text: "initial' ::" })
  })

  it('leaves an imported function applied without parentheses alone', () => {
    expectPlain({ spec, source, text: 'fromMaybe 0' })
  })

  it('reads a primed constructor as one type token', () => {
    const primed = "data Tree' a = Leaf' | Node' a (Tree' a)"
    expect(textFor({ spec, source: primed, group: 'type' })).toEqual([
      "Tree'",
      "Leaf'",
      "Node'",
      "Tree'",
    ])
    expect(textFor({ spec, source: primed, group: 'character' })).toEqual([])
  })

  it('reads dashes followed by a symbol as an operator, not a comment', () => {
    const operatorDefinition = 'x --> y = x + y'
    expect(textFor({ spec, source: operatorDefinition, group: 'operator' })).toEqual([
      '-->',
      '=',
      '+',
    ])
    expect(textFor({ spec, source: operatorDefinition, group: 'comment' })).toEqual([])
  })

  it('still reads a bare run of dashes as a comment', () => {
    expect(textFor({ spec, source: '---- a divider', group: 'comment' })).toEqual([
      '---- a divider',
    ])
  })

  it('reads a constructor before a composition dot as a type, not a module', () => {
    const composed = 'toDouble = Just . fromIntegral'
    expect(textFor({ spec, source: composed, group: 'type' })).toEqual(['Just'])
    expect(textFor({ spec, source: composed, group: 'module' })).toEqual([])
  })

  it('answers to the hs alias too', () => {
    expect(spec.aliases).toContain('hs')
  })
})
