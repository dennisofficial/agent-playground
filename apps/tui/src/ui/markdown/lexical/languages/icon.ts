import { doubleQuoted, hashComment, pattern, singleQuoted } from '../rules'
import type { LanguageSpec } from '../spec'

export const icon: LanguageSpec = {
  filetype: 'icon',
  aliases: ['icn'],
  call: 'function.call',
  rules: [
    hashComment(),
    doubleQuoted(),
    singleQuoted(),
    pattern({ match: /[+\-*\/%<>=!|^~\\?:@]+(?=&[a-z])/, group: 'operator' }),
    pattern({ match: /(?<=\.)[A-Za-z_][A-Za-z0-9_]*/, group: 'variable.member' }),
    pattern({ match: /\$[a-z]+/, group: 'keyword.directive', atLineStart: true }),
  ],
  identifier: /&?[A-Za-z_][A-Za-z0-9_]*/,
  number: /(?:\d+[rR][0-9A-Za-z]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
  operators: '+-*/%<>=!&|^~\\?:@',
  words: {
    keyword: [
      'procedure', 'end', 'if', 'then', 'else', 'while', 'do', 'until', 'repeat', 'every',
      'suspend', 'return', 'fail', 'break', 'next', 'case', 'of', 'default', 'create', 'local',
      'static', 'global', 'record', 'initial', 'link', 'invocable', 'not', 'to', 'by',
    ],
    'function.builtin': [
      'write', 'writes', 'read', 'reads', 'stop', 'find', 'upto', 'many', 'any', 'match', 'move',
      'tab', 'pos', 'close', 'open', 'exit', 'image', 'type', 'copy', 'sort', 'put', 'pull',
      'push', 'get', 'insert', 'delete', 'member', 'key',
    ],
    'constant.builtin': [
      '&allocated', '&ascii', '&clock', '&collections', '&cset', '&current', '&date', '&dateline',
      '&digits', '&dump', '&e', '&error', '&errornumber', '&errortext', '&errorvalue', '&errout',
      '&fail', '&features', '&file', '&host', '&input', '&lcase', '&letters', '&level', '&line',
      '&main', '&null', '&output', '&phi', '&pi', '&pos', '&progname', '&random', '&regions',
      '&source', '&storage', '&subject', '&time', '&trace', '&ucase', '&version', '&window',
      '&col', '&row', '&x', '&y', '&interval', '&control', '&shift', '&meta', '&resize',
      '&lpress', '&mpress', '&rpress', '&ldrag', '&mdrag', '&rdrag', '&lrelease', '&mrelease',
      '&rrelease',
    ],
  },
}
