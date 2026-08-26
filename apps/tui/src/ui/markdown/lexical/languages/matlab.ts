import { lineComment, pattern, percentComment, quoted } from '../rules'
import type { LanguageSpec } from '../spec'

const charArrayNotTranspose = /(?<![\w)\]}.'"])'(?:[^'\n]|'')*'/
const leadingDotNumber = /\.\d[\d_]*(?:[eE][+-]?\d+)?[ij]?/
const namedFunctionHandle = /@[A-Za-z_][A-Za-z0-9_]*/

export const matlab: LanguageSpec = {
  filetype: 'matlab',
  aliases: ['m', 'octave'],
  call: 'function.call',
  rules: [
    quoted({
      open: '%{',
      close: '%}',
      group: 'comment',
      escape: null,
      multiline: true,
      atLineStart: true,
    }),
    percentComment(),
    lineComment({ open: '...' }),
    quoted({ open: '"', escape: null, doubled: true }),
    pattern({ match: charArrayNotTranspose, group: 'string' }),
    pattern({ match: leadingDotNumber, group: 'number' }),
    pattern({ match: namedFunctionHandle, group: 'function' }),
  ],
  number: /(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[ij]?)/,
  operators: "+-*/\\:'<>=!&|^~",
  words: {
    keyword: [
      'function', 'end', 'endfunction', 'if', 'elseif', 'else', 'endif', 'switch', 'case',
      'otherwise', 'endswitch', 'for', 'endfor', 'while', 'endwhile', 'break', 'continue',
      'return', 'try', 'catch', 'endtry', 'classdef', 'methods', 'properties', 'events',
      'enumeration', 'global', 'persistent', 'parfor', 'spmd', 'arguments', 'nargin', 'nargout',
    ],
    'function.builtin': [
      'disp', 'fprintf', 'sprintf', 'error', 'warning', 'size', 'length', 'numel', 'zeros',
      'ones', 'eye', 'rand', 'linspace', 'reshape', 'sum', 'mean', 'max', 'min', 'find',
      'isempty', 'strcmp', 'num2str', 'str2num',
    ],
    'constant.builtin': [
      'true', 'false', 'nan', 'NaN', 'inf', 'Inf', 'pi', 'eps', 'i', 'j',
    ],
  },
}
