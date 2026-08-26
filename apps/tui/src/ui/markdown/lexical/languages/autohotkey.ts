import { blockComment, pattern, quoted, semicolonComment } from '../rules'
import type { LanguageSpec } from '../spec'

const HOTKEY = /[#!^+<>~$*]*(?:\w+|[^\s:;#])(?: *& *[#!^+<>~$*]*(?:\w+|[^\s:;#]))? *::/
const HOTSTRING = /:[A-Za-z0-9*?]*:[^\n:]+::/
const DIRECTIVE = /#[A-Za-z][A-Za-z0-9_]*/
const DEREFERENCE = /%[A-Za-z_][A-Za-z0-9_]*%/
const SINGLE_QUOTED = /'(?:[^'\n]|'')*'/

export const autohotkey: LanguageSpec = {
  filetype: 'autohotkey',
  aliases: ['ahk'],
  call: 'function.call',
  caseInsensitive: true,
  operators: '+-*/%<>=!&|^~:',
  rules: [
    semicolonComment(),
    blockComment({ open: '/*', close: '*/' }),
    pattern({ match: HOTSTRING, group: 'label', atLineStart: true }),
    pattern({ match: HOTKEY, group: 'label', atLineStart: true }),
    pattern({ match: DIRECTIVE, group: 'keyword.directive', atLineStart: true }),
    quoted({ open: '"', escape: '`', doubled: true }),
    pattern({ match: SINGLE_QUOTED, group: 'string' }),
    pattern({ match: DEREFERENCE, group: 'variable' }),
  ],
  words: {
    keyword: [
      'if', 'else', 'loop', 'while', 'for', 'in', 'and', 'or', 'not', 'return', 'break',
      'continue', 'global', 'local', 'static', 'class', 'extends', 'new', 'try', 'catch',
      'finally', 'throw', 'switch', 'case', 'default', 'until', 'goto', 'gosub', 'exit',
      'exitapp',
    ],
    'function.builtin': [
      'MsgBox', 'Send', 'SendInput', 'Sleep', 'WinActivate', 'WinWait', 'SetTimer', 'FileRead',
      'FileAppend', 'Run', 'Click', 'Hotkey', 'Random', 'StrLen', 'SubStr', 'InStr',
    ],
    'constant.builtin': ['true', 'false'],
    'variable.builtin': [
      'this', 'A_Index', 'A_ThisHotkey', 'A_ScriptName', 'A_ScriptDir', 'A_LoopField',
      'A_Space', 'A_Tab', 'A_Args', 'A_Clipboard', 'ClipBoard', 'ErrorLevel',
    ],
  },
}
