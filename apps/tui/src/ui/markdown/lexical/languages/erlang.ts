import {
  doubleQuoted,
  pattern,
  percentComment,
  singleQuoted,
  tripleQuoted,
  variableByCase,
} from '../rules'
import type { LanguageSpec } from '../spec'

export const erlang: LanguageSpec = {
  filetype: 'erlang',
  aliases: ['erl'],
  call: 'function.call',
  rules: [
    percentComment(),
    tripleQuoted(),
    doubleQuoted(),
    singleQuoted(),
    pattern({ match: /-[a-z][A-Za-z0-9_]*/, group: 'keyword.directive', atLineStart: true }),
    pattern({ match: /\?[A-Za-z_][A-Za-z0-9_]*/, group: 'constant.macro' }),
    pattern({ match: /\$(?:\\.|[^\n])/, group: 'character' }),
    pattern({ match: /[a-z][A-Za-z0-9_@]*(?=:)/, group: 'module' }),
    variableByCase(),
  ],
  identifier: /[a-z][A-Za-z0-9_@]*/,
  number: /(?:\d+#[0-9A-Za-z]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/,
  operators: '+-*/<>=!&|^~:?',
  words: {
    keyword: [
      'after', 'and', 'andalso', 'band', 'begin', 'bnot', 'bor', 'bsl', 'bsr', 'bxor',
      'case', 'catch', 'cond', 'div', 'else', 'end', 'fun', 'if', 'let', 'maybe', 'not',
      'of', 'or', 'orelse', 'receive', 'rem', 'try', 'when', 'xor',
    ],
    'constant.builtin': ['true', 'false'],
    type: [
      'any', 'arity', 'atom', 'binary', 'bitstring', 'boolean', 'byte', 'char', 'float',
      'integer', 'iodata', 'iolist', 'neg_integer', 'no_return', 'non_neg_integer',
      'nonempty_list', 'pid', 'port', 'pos_integer', 'reference', 'term',
    ],
    'function.builtin': [
      'abs', 'apply', 'atom_to_list', 'byte_size', 'element', 'hd', 'integer_to_list',
      'is_atom', 'is_binary', 'is_boolean', 'is_float', 'is_function', 'is_integer', 'is_list',
      'is_map', 'is_number', 'is_pid', 'is_record', 'is_tuple', 'length', 'list_to_atom',
      'list_to_integer', 'make_ref', 'map_size', 'round', 'self', 'setelement', 'spawn',
      'spawn_link', 'throw', 'tl', 'trunc', 'tuple_size', 'tuple_to_list',
    ],
  },
}
