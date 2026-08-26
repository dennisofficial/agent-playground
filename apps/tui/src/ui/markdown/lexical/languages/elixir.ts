import {
  annotation,
  doubleQuoted,
  hashComment,
  pattern,
  quoted,
  singleQuoted,
  tripleQuoted,
} from '../rules'
import type { LanguageSpec } from '../spec'

const HEREDOC_SIGIL = /~[a-zA-Z]+(?:"""[\s\S]*?"""|'''[\s\S]*?''')[a-zA-Z]*/

const SIGIL =
  /~[a-zA-Z]+(?:\/(?:\\.|[^/\n])*\/|\((?:\\.|[^)\n])*\)|\[(?:\\.|[^\]\n])*\]|\{(?:\\.|[^}\n])*\}|<(?:\\.|[^>\n])*>|\|(?:\\.|[^|\n])*\||"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*')[a-zA-Z]*/

export const elixir: LanguageSpec = {
  filetype: 'elixir',
  aliases: ['ex', 'exs'],
  call: 'function.call',
  rules: [
    hashComment(),
    pattern({ match: HEREDOC_SIGIL, group: 'string' }),
    tripleQuoted(),
    quoted({ open: "'''", escape: null, multiline: true }),
    pattern({ match: SIGIL, group: 'string' }),
    doubleQuoted(),
    singleQuoted(),
    pattern({ match: /::/, group: 'operator' }),
    pattern({ match: /:(?:"[^"\n]*"|[A-Za-z_][A-Za-z0-9_]*[?!]?)/, group: 'string.special.symbol' }),
    pattern({ match: /[a-z_][A-Za-z0-9_]*[?!]?:(?!:)/, group: 'string.special.key' }),
    annotation(),
    pattern({ match: /[A-Z][A-Za-z0-9_]*/, group: 'module' }),
    pattern({ match: /\?(?:\\.|\S)/, group: 'character' }),
  ],
  identifier: /[a-z_][A-Za-z0-9_]*[?!]?/,
  words: {
    keyword: [
      'after', 'alias', 'and', 'case', 'catch', 'cond', 'def', 'defdelegate', 'defexception',
      'defguard', 'defguardp', 'defimpl', 'defmacro', 'defmacrop', 'defmodule', 'defoverridable',
      'defp', 'defprotocol', 'defstruct', 'do', 'else', 'end', 'fn', 'for', 'if', 'import', 'in',
      'not', 'or', 'quote', 'raise', 'receive', 'require', 'rescue', 'super', 'throw', 'try',
      'unless', 'unquote', 'use', 'when', 'with',
    ],
    'constant.builtin': [
      'true', 'false', 'nil', '__MODULE__', '__DIR__', '__ENV__', '__CALLER__', '__STACKTRACE__',
    ],
    'function.builtin': [
      'abs', 'apply', 'binary_part', 'byte_size', 'div', 'elem', 'hd', 'inspect', 'is_atom',
      'is_binary', 'is_boolean', 'is_float', 'is_function', 'is_integer', 'is_list', 'is_map',
      'is_nil', 'is_number', 'is_tuple', 'length', 'map_size', 'max', 'min', 'rem', 'round',
      'self', 'send', 'spawn', 'spawn_link', 'struct', 'tl', 'to_charlist', 'to_string', 'trunc',
      'tuple_size',
    ],
  },
}
