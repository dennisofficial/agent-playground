import { blockComment, hashComment, pattern, quoted, sigilVariable, singleQuoted } from '../rules'
import type { LanguageSpec } from '../spec'

const automaticVariable =
  /\$(?:_|args|input|this|error|matches|host|home|pwd|profile|psitem|pscmdlet|psscriptroot|pscommandpath|psboundparameters|psversiontable|psculture|myinvocation|lastexitcode|stacktrace|executioncontext|foreach|switch|ofs)\b/i

const scopedVariable = /\$(?:env|script|global|local|private|using|variable):[A-Za-z_][A-Za-z0-9_]*/i

const bracedVariable = /\$\{[^}\n]*\}/

const comparisonOperator =
  /-(?:c?(?:eq|ne|gt|ge|lt|le|notlike|like|notmatch|match|notcontains|contains|notin|in|replace|split|join)|i(?:eq|ne|gt|ge|lt|le)|isnot|is|as|and|or|xor|not|band|bor|bxor|bnot|shl|shr|f)\b/i

const parameterSwitch = /-[A-Za-z][A-Za-z0-9]*/

const declarationAttribute = /\[[A-Za-z_][A-Za-z0-9_.]*(?=\()/

const typeLiteral = /\[[A-Za-z_][A-Za-z0-9_.]*(?:\[\])?\]/

export const powershell: LanguageSpec = {
  filetype: 'powershell',
  aliases: ['ps1', 'pwsh', 'posh'],
  caseInsensitive: true,
  call: 'function.call',
  rules: [
    blockComment({ open: '<#', close: '#>' }),
    hashComment(),
    quoted({ open: '@"', close: '"@', escape: null, multiline: true }),
    quoted({ open: "@'", close: "'@", escape: null, multiline: true }),
    quoted({ open: '"', escape: '`' }),
    singleQuoted({ escape: null, doubled: true }),
    pattern({ match: /\$(?:true|false|null)\b/i, group: 'constant.builtin' }),
    pattern({ match: automaticVariable, group: 'variable.builtin' }),
    pattern({ match: scopedVariable, group: 'variable' }),
    pattern({ match: bracedVariable, group: 'variable' }),
    sigilVariable({ sigil: '$' }),
    sigilVariable({ sigil: '@' }),
    pattern({ match: comparisonOperator, group: 'operator' }),
    pattern({ match: parameterSwitch, group: 'attribute' }),
    pattern({ match: declarationAttribute, group: 'attribute' }),
    pattern({ match: typeLiteral, group: 'type' }),
  ],
  identifier: /[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z][A-Za-z0-9_]*)*/,
  number:
    /(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[kKmMgGtTpP][bB])?[lLdD]?/,
  words: {
    keyword: [
      'function', 'filter', 'param', 'dynamicparam', 'begin', 'process', 'end', 'if', 'elseif',
      'else', 'switch', 'foreach', 'while', 'do', 'until', 'for', 'return', 'break', 'continue',
      'try', 'catch', 'finally', 'throw', 'trap', 'class', 'enum', 'using', 'workflow', 'in',
      'exit', 'static', 'hidden', 'data', 'default',
    ],
    'function.builtin': [
      'Write-Host', 'Write-Output', 'Write-Error', 'Write-Warning', 'Write-Verbose',
      'Write-Debug', 'Read-Host', 'Get-ChildItem', 'Get-Content', 'Set-Content', 'Add-Content',
      'Get-Item', 'Set-Item', 'Remove-Item', 'Copy-Item', 'New-Item', 'Test-Path', 'Join-Path',
      'Split-Path', 'Resolve-Path', 'New-Object', 'ForEach-Object', 'Where-Object',
      'Select-Object', 'Sort-Object', 'Group-Object', 'Measure-Object', 'Compare-Object',
      'Out-Null', 'Out-File', 'Out-String', 'Import-Module', 'Export-ModuleMember',
      'Get-Command', 'Get-Member', 'Get-Help', 'Invoke-Command', 'Invoke-Expression',
      'Invoke-RestMethod', 'Invoke-WebRequest', 'Start-Process', 'Stop-Process', 'Get-Process',
      'Start-Sleep', 'ConvertTo-Json', 'ConvertFrom-Json', 'Set-StrictMode',
    ],
  },
}
