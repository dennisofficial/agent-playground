import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { clojure as spec } from '../clojure'

const source = [
  ';; a tiny calculator',
  '(ns example.calculator',
  '  (:require [clojure.string :as str]))',
  '',
  '(def built (atom 0))',
  '',
  '(def ^:private ops #{:add :multiply})',
  '',
  '(defn add',
  '  "Sum two numbers.',
  '   Returns their total."',
  '  [x y]',
  '  (+ x y))',
  '',
  '(defprotocol Multiplier',
  '  (multiply [this x y]))',
  '',
  '(defrecord Calculator [scale]',
  '  Multiplier',
  '  (multiply [this x y]',
  '    (* scale x y)))',
  '',
  '(defn swap-in! [amount]',
  '  (swap! built + amount))',
  '',
  '(defn nil-safe? [value]',
  '  (if (nil? value) 0 value))',
  '',
  '(defn negate [x]',
  '  (* -1 x))',
  '',
  '(defn safe-divide [x y]',
  '  (try',
  '    (/ x y)',
  '    (catch ArithmeticException _',
  '      nil)',
  '    (finally',
  '      (swap-in! 1))))',
  '',
  '(defn dispatch [op]',
  '  (case op',
  '    :add (fn [x y] (+ x y))',
  '    :multiply #(* %1 %2)',
  "    (throw (ex-info \"unknown op\" {:op op ::hint 'dispatch}))))",
  '',
  '(defn slug [text]',
  '  (str/replace text #"\\s+" "-"))',
  '',
  '(let [calc (->Calculator 2)]',
  '  (swap-in! 1)',
  '  (println (str "product=" (multiply calc 5 3) \\newline))',
  '  (println (str/join ", " ["sum" (add 1 2) (safe-divide 6 3)]))',
  '  (when-let [n (nil-safe? @built)]',
  '    (println (format "built=%d, ops=%s" n (count ops)))))',
  '',
].join('\n')

const docstringForm = [
  '(defn add',
  '  "Sum two numbers.',
  '   Returns their total."',
  '  [x y]',
  '  (+ x y))',
].join('\n')

describe('clojure lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'string.regexp',
        'string.special.symbol',
        'character',
        'punctuation.special',
        'keyword',
        'type',
        'number',
        'constant.builtin',
        'function.builtin',
      ],
    })
  })

  it('reads keywords, namespaced and auto-resolved alike', () => {
    expect(textFor({ spec, source, group: 'string.special.symbol' })).toEqual([
      ':require',
      ':as',
      ':private',
      ':add',
      ':multiply',
      ':add',
      ':multiply',
      ':op',
      '::hint',
    ])
  })

  it('reads a character literal by its long name', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(['\\newline'])
  })

  it('reads a regex literal as a string', () => {
    expect(textFor({ spec, source, group: 'string.regexp' })).toEqual(['#"\\s+"'])
  })

  it('reads a capitalised name as a type', () => {
    expect(textFor({ spec, source, group: 'type' })).toEqual([
      'Multiplier',
      'Calculator',
      'Multiplier',
      'ArithmeticException',
    ])
  })

  it('reads reader macros as punctuation', () => {
    expect(textFor({ spec, source, group: 'punctuation.special' })).toEqual([
      '^',
      '#',
      '#',
      "'",
      '@',
    ])
  })

  it('reads a double-quoted string but not the regex around it', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"Sum two numbers.\n   Returns their total."',
      '"unknown op"',
      '"-"',
      '"product="',
      '", "',
      '"sum"',
      '"built=%d, ops=%s"',
    ])
  })

  it('keeps a multi-line docstring whole instead of reopening at the newline', () => {
    expect(textFor({ spec, source: docstringForm, group: 'string' })).toEqual([
      '"Sum two numbers.\n   Returns their total."',
    ])
    expect(groupsIn({ spec, source: docstringForm })).toEqual(
      new Set(['keyword', 'string', 'function.builtin']),
    )
  })

  it('leaves a symbol whose head spells a builtin alone', () => {
    expectPlain({ spec, source, text: 'nil-safe?' })
  })

  it('takes a hyphenated, banged symbol as one token', () => {
    expect(groupsIn({ spec, source: '(swap-in! total)' })).toEqual(new Set())
  })

  it('takes a threading macro as one keyword, hyphen and arrow included', () => {
    expect(textFor({ spec, source: '(some-> m :a inc)', group: 'keyword' })).toEqual(['some->'])
  })

  it('looks up a punctuated symbol as one word', () => {
    expect(textFor({ spec, source: '(not= (dec x) -1)', group: 'function.builtin' })).toEqual([
      'not=',
      'dec',
    ])
  })

  it('does not split a symbol that contains a keyword', () => {
    expect(textFor({ spec, source: '(def cond-map* {:a 1})', group: 'keyword' })).toEqual(['def'])
  })

  it('reads a negative literal and an anonymous-fn argument apart', () => {
    expect(textFor({ spec, source: '#(* %1 -2)', group: 'number' })).toEqual(['-2'])
  })

  it('reads a signed ratio, radix and hex literal whole', () => {
    expect(textFor({ spec, source: '(+ -1/2 1/3)', group: 'number' })).toEqual(['-1/2', '1/3'])
    expect(textFor({ spec, source: '(bit-and -0xff 2r1011)', group: 'number' })).toEqual([
      '-0xff',
      '2r1011',
    ])
    expect(textFor({ spec, source: '(* -1.5e-3 1M)', group: 'number' })).toEqual(['-1.5e-3', '1M'])
  })

  it('answers to the edn alias too', () => {
    expect(spec.aliases).toContain('edn')
  })
})
