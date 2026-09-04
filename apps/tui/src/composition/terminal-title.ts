const SET_TAB_TITLE = '\x1b]0;'
const TITLE_END = '\x07'

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]+/g
const WHITESPACE_RUNS = /\s+/g

const basenameOf = (directory: string): string => {
  const trimmed = directory.replace(/\/+$/, '')
  const base = trimmed.split('/').at(-1) ?? trimmed
  return base.length === 0 ? directory : base
}

export function terminalTitleSequence(args: {
  name: string | null
  directory: string
}): string {
  const title = args.name ?? basenameOf(args.directory)
  const clean = title.replace(CONTROL_CHARACTERS, ' ').replace(WHITESPACE_RUNS, ' ').trim()
  return `${SET_TAB_TITLE}${clean}${TITLE_END}`
}
