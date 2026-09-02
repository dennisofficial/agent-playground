export const shellKeywords = new Set([
  'for',
  'while',
  'until',
  'if',
  'elif',
  'case',
  'select',
  'function',
  'coproc',
])

export const segmentIntroducers = new Set([
  'do',
  'then',
  'else',
  '!',
  'time',
  'exec',
  'nohup',
  'command',
  'builtin',
  '{',
  '}',
])

export const blockTerminators = new Set(['done', 'fi', 'esac', 'in'])

export const interpreters = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'node',
  'deno',
  'bun',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'php',
  'osascript',
])

export const wrappers = new Set(['sudo', 'env', 'xargs', 'nice', 'timeout', 'doas'])

export const programsThatDestroyTheirOperands = new Set([
  'rm',
  'rmdir',
  'mv',
  'dd',
  'shred',
  'truncate',
  'unlink',
  'chmod',
  'chown',
  'chgrp',
  'mkfs',
  'ln',
  'git',
  'docker',
  'kubectl',
  'terraform',
  'systemctl',
  'kill',
  'killall',
  'pkill',
  'rsync',
  'tee',
  'sudo',
  'doas',
])

export const scriptFlag = '-c'

export const maximumScriptNesting = 3

export const fetchers = new Set(['curl', 'wget', 'http', 'httpie', 'aria2c', 'fetch'])
