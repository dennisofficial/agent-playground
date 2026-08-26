import { pattern } from '../rules'
import type { LanguageSpec } from '../spec'

const backslashComment = pattern({ match: /\\(?=\s|$)[^\n]*/, group: 'comment' })

const stackComment = pattern({ match: /\((?=\s|$)[^)]*\)?/, group: 'comment' })

const stringWord = pattern({ match: /[^\s"]+"(?=[ \t])[^"\n]*"?/, group: 'string' })

const definitionName = pattern({
  match: /(?<=(?:^|[ \t\n]):[ \t]+)\S+/,
  group: 'function',
})

const dataName = pattern({
  match: /(?<=(?:^|[ \t\n])(?:2?variable|fvariable|2?constant|value|defer)[ \t]+)\S+/i,
  group: 'variable',
})

const prefixedNumber = pattern({
  match: /[-+]?(?:\$[0-9A-Fa-f]+|#[0-9]+|%[01]+|[0-9]+\.?[0-9]*)(?=\s|$)/,
  group: 'number',
})

export const forth: LanguageSpec = {
  filetype: 'forth',
  aliases: ['fth', '4th'],
  caseInsensitive: true,
  identifier: /\S+/,
  operators: '',
  rules: [
    backslashComment,
    stackComment,
    stringWord,
    definitionName,
    dataName,
    prefixedNumber,
  ],
  words: {
    keyword: [
      ':', ';', ':noname', 'if', 'then', 'else', 'do', '?do', 'loop', '+loop', 'leave', 'unloop',
      'begin', 'until', 'while', 'repeat', 'again', 'case', 'of', 'endof', 'endcase', 'variable',
      '2variable', 'fvariable', 'constant', '2constant', 'value', 'to', 'create', 'allot', 'does>',
      'immediate', 'recurse', 'exit', 'postpone', 'literal', 'defer', 'is', '[', ']', "[']",
      '[char]', 'compile,', 'include', 'require', 'marker', 'forget', 'vocabulary', 'wordlist',
      'definitions',
    ],
    'constant.builtin': ['true', 'false', 'bl', 'pad'],
    'function.builtin': [
      'dup', '?dup', 'drop', 'swap', 'over', 'rot', '-rot', 'nip', 'tuck', 'pick', 'roll', 'depth',
      '2dup', '2drop', '2swap', '2over', '>r', 'r>', 'r@', 'i', 'j',
      '@', '!', '+!', 'c@', 'c!', 'cell+', 'cells', 'char+', 'chars', 'char', 'count', 'move',
      'fill', 'erase', 'here', 'align', 'aligned', 'allocate', 'free', ',', 'c,',
      '.', '.s', '.r', 'u.', 'emit', 'cr', 'type', 'space', 'spaces', 'key', 'accept', 'page',
      '<#', '#', '#s', '#>', 'hold', 'sign',
      'decimal', 'hex', 'base', 'abs', 'negate', 'min', 'max', 'mod', '/mod', '*/', '*/mod',
      '1+', '1-', '2*', '2/', 'execute', 'abort', 'quit', 'bye', 'words', 'see',
    ],
    operator: [
      '+', '-', '*', '/', '=', '<>', '<', '>', '<=', '>=', '0=', '0<', '0>', 'u<', 'u>', 'd<',
      'and', 'or', 'xor', 'invert', 'lshift', 'rshift',
    ],
  },
}
