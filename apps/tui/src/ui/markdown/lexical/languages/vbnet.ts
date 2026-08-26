import { lineComment, pattern, quoted } from '../rules'
import type { LanguageSpec } from '../spec'

export const vbnet: LanguageSpec = {
  filetype: 'vbnet',
  aliases: ['vb', 'vb.net', 'visualbasic'],
  call: 'function.call',
  caseInsensitive: true,
  rules: [
    lineComment({ open: "'" }),
    pattern({ match: /[Rr][Ee][Mm](?![A-Za-z0-9_])[^\n]*/, group: 'comment' }),
    quoted({ open: '"', escape: null, doubled: true }),
    pattern({
      match: /#(?:elseif|externalchecksum|externalsource|region|const|disable|enable|else|end|if)(?![A-Za-z0-9_])/i,
      group: 'keyword.directive',
      atLineStart: true,
    }),
    pattern({
      match: /&(?:[Hh][0-9A-Fa-f_]+|[Oo][0-7_]+|[Bb][01_]+)(?:[Uu]?[SILsil])?(?![A-Za-z0-9_])/,
      group: 'number',
    }),
    pattern({ match: /<[A-Za-z_][A-Za-z0-9_.]*(?:\([^>\n]*\))?>/, group: 'attribute' }),
  ],
  operators: '+-*/\\<>=&^',
  words: {
    keyword: [
      'Module', 'Class', 'Structure', 'Interface', 'Namespace', 'Imports', 'Sub', 'Function',
      'Enum', 'Delegate', 'Operator', 'Declare', 'Lib', 'Alias', 'End', 'Dim', 'ReDim', 'As',
      'New', 'Of', 'If', 'Then', 'Else', 'ElseIf', 'Select', 'Case', 'For', 'Each', 'In', 'To',
      'Step', 'Next', 'While', 'Do', 'Loop', 'Until', 'Exit', 'Continue', 'GoTo', 'Call',
      'Return', 'Try', 'Catch', 'Finally', 'Throw', 'With', 'Using', 'Public', 'Private',
      'Protected', 'Friend', 'Global', 'Shared', 'Static', 'Const', 'ReadOnly', 'Overrides',
      'Overloads', 'Overridable', 'Shadows', 'MustInherit', 'NotInheritable', 'ByVal', 'ByRef',
      'Optional', 'ParamArray', 'Property', 'Get', 'Set', 'Event', 'RaiseEvent', 'WithEvents',
      'AddHandler', 'RemoveHandler', 'AddressOf', 'Handles', 'Implements', 'Inherits', 'Partial',
      'Async', 'Await', 'Iterator', 'Yield', 'SyncLock', 'Option', 'On', 'Default',
      'WriteOnly', 'When', 'Erase', 'Stop', 'Resume', 'Error', 'Let', 'Not', 'And', 'Or', 'Xor',
      'AndAlso', 'OrElse', 'Mod', 'Is', 'IsNot', 'Like', 'TypeOf', 'GetType', 'DirectCast',
      'CType', 'TryCast', 'MyBase', 'MyClass',
    ],
    type: [
      'Integer', 'String', 'Boolean', 'Double', 'Single', 'Decimal', 'Long', 'Short', 'Byte',
      'SByte', 'UShort', 'UInteger', 'ULong', 'Char', 'Date', 'Object',
    ],
    'constant.builtin': ['True', 'False', 'Nothing', 'Me'],
  },
}
