import { doubleQuoted, lineComment, pattern, singleQuoted } from '../rules'
import type { LanguageSpec } from '../spec'

const VISUAL_RANGE = /'[<>],'[<>]/
const REGISTER = /@(?:[-"+*.:%#=~_\/0-9]|[A-Za-z](?![A-Za-z0-9_#]))/
const SCOPED_VARIABLE = /[abglstvw]:[A-Za-z0-9_#]+/
const OPTION = /&(?:[lg]:)?[A-Za-z_][A-Za-z0-9_]*/
const KEYCODE = /<[A-Za-z0-9_-]+>/

export const vim: LanguageSpec = {
  filetype: 'vim',
  aliases: ['vimscript', 'vimrc'],
  call: 'function.call',
  rules: [
    lineComment({ open: '"', atLineStart: true }),
    pattern({ match: VISUAL_RANGE, group: 'constant' }),
    pattern({ match: REGISTER, group: 'variable.builtin' }),
    doubleQuoted(),
    singleQuoted({ escape: null, doubled: true }),
    pattern({ match: SCOPED_VARIABLE, group: 'variable' }),
    pattern({ match: OPTION, group: 'variable.builtin' }),
    pattern({ match: KEYCODE, group: 'character' }),
  ],
  identifier: /[A-Za-z_][A-Za-z0-9_#]*/,
  operators: '+-*/%<>=!&|^~#.',
  words: {
    keyword: [
      'function', 'endfunction', 'endfunc', 'func', 'delfunction', 'if', 'endif', 'elseif', 'else',
      'while', 'endwhile', 'for', 'endfor', 'in', 'try', 'catch', 'finally', 'endtry', 'throw',
      'let', 'unlet', 'const', 'return', 'call', 'echo', 'echom', 'echomsg', 'echoerr', 'echohl',
      'execute', 'exe', 'normal', 'source', 'runtime', 'set', 'setlocal', 'setglobal', 'filetype',
      'colorscheme', 'scriptencoding', 'augroup', 'autocmd', 'au', 'command', 'delcommand',
      'highlight', 'hi', 'syntax', 'syn', 'map', 'noremap', 'nmap', 'imap', 'vmap', 'nnoremap',
      'inoremap', 'vnoremap', 'xnoremap', 'onoremap', 'cnoremap', 'tnoremap', 'silent', 'break',
      'continue', 'finish',
    ],
    'function.builtin': [
      'len', 'empty', 'type', 'string', 'printf', 'substitute', 'matchstr', 'match', 'split',
      'join', 'extend', 'remove', 'keys', 'values', 'items', 'has_key', 'get', 'range', 'copy',
      'deepcopy', 'exists', 'has', 'expand', 'fnamemodify', 'line', 'col', 'getline', 'setline',
      'input', 'sort', 'filter', 'reverse', 'str2nr', 'nr2char', 'char2nr', 'tolower', 'toupper',
      'trim', 'repeat', 'abs', 'max', 'min', 'strlen', 'strpart', 'count', 'index', 'insert',
      'bufnr', 'winnr', 'system', 'shellescape', 'submatch',
    ],
  },
}
