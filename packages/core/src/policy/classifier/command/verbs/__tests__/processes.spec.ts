import { describe, expect, it } from 'bun:test'

import { EDeed, EDeedRealm } from '../../../deed'
import { actionsFor, oneDeed } from './read-deeds'

const actionOf = (command: string): EDeed => oneDeed({ command }).action

describe('the process verbs', () => {
  it('reads kill, pkill and killall as signalling processes', () => {
    expect(actionOf('kill -9 4321')).toBe(EDeed.KillProcess)
    expect(actionOf('pkill -f atlas')).toBe(EDeed.KillProcess)
    expect(actionOf('killall node')).toBe(EDeed.KillProcess)
  })

  it('names the process it would signal', () => {
    const deed = oneDeed({ command: 'kill -9 4321' })

    expect(deed.targets).toEqual([{ realm: EDeedRealm.Process, value: '4321' }])
  })

  it('sees the kill on the far side of an xargs', () => {
    expect(actionsFor({ command: 'lsof -t -i:3000 | xargs kill -9' })).toEqual([
      EDeed.ReadOnly,
      EDeed.KillProcess,
    ])
  })

  it('separates stopping a service from reading its state', () => {
    expect(actionOf('systemctl stop atlas')).toBe(EDeed.KillProcess)
    expect(actionOf('systemctl status atlas')).toBe(EDeed.ReadOnly)
    expect(actionOf('docker stop web')).toBe(EDeed.KillProcess)
    expect(actionOf('docker ps')).toBe(EDeed.ReadOnly)
  })
})
