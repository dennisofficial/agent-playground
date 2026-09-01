import { EDeed, EDeedRealm, type DeedTarget } from '../../deed'
import { readOnly, sketch, subverbOf, verbOf, type CommandView, type VerbTable } from './view'

const signalPrograms = new Set(['kill', 'killall', 'pkill'])

const stoppingVerbs: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['systemctl', new Set(['stop', 'restart', 'kill', 'disable', 'mask'])],
  ['docker', new Set(['kill', 'stop', 'rm', 'restart', 'pause'])],
  ['pm2', new Set(['stop', 'delete', 'restart', 'kill'])],
  ['launchctl', new Set(['unload', 'stop', 'kickstart'])],
])

const readingVerbs: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['systemctl', new Set(['status', 'list-units', 'show', 'is-active'])],
  ['docker', new Set(['ps', 'images', 'logs', 'inspect', 'version'])],
  ['pm2', new Set(['list', 'status', 'logs'])],
  ['launchctl', new Set(['list', 'print'])],
])

function processTargets({ view }: { view: CommandView }): readonly DeedTarget[] {
  return view.words.map((word) => ({ realm: EDeedRealm.Process, value: word.raw }))
}

export const processVerbs: VerbTable = ({ view }) => {
  if (signalPrograms.has(view.program)) {
    return sketch({
      action: EDeed.KillProcess,
      targets: processTargets({ view }),
      summary: 'signals running processes',
    })
  }

  const verb = verbOf({ view })
  if (verb === undefined) return undefined
  if (readingVerbs.get(view.program)?.has(verb) === true) {
    return readOnly({ summary: `reads process state (${view.program} ${verb})` })
  }
  if (stoppingVerbs.get(view.program)?.has(verb) !== true) return undefined

  const named = subverbOf({ view })

  return sketch({
    action: EDeed.KillProcess,
    targets: named === undefined ? [] : [{ realm: EDeedRealm.Process, value: named }],
    summary: `stops a running service (${view.program} ${verb})`,
  })
}
