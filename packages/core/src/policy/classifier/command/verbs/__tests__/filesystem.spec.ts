import { describe, expect, it } from 'bun:test'

import { EDeed, EDeedRealm } from '../../../deed'
import { oneDeed, PROJECT, targetValues } from './read-deeds'

const actionOf = (command: string): EDeed => oneDeed({ command }).action

describe('the filesystem verbs', () => {
  it('resolves what an rm would remove against the segment cwd', () => {
    const deed = oneDeed({ command: 'rm -rf tmp', workdir: '/a/b' })

    expect(deed.action).toBe(EDeed.RemovePath)
    expect(deed.targets).toEqual([{ realm: EDeedRealm.Path, value: '/a/b/tmp' }])
  })

  it('reads rmdir, shred and truncate as removals too', () => {
    expect(actionOf('rmdir build')).toBe(EDeed.RemovePath)
    expect(actionOf('shred -u secrets.txt')).toBe(EDeed.RemovePath)
    expect(actionOf('truncate -s 0 log.txt')).toBe(EDeed.RemovePath)
  })

  it('treats a move as leaving nothing at the source', () => {
    const deed = oneDeed({ command: 'mv a.ts b.ts' })

    expect(deed.action).toBe(EDeed.RemovePath)
    expect(targetValues({ deed })).toEqual([`${PROJECT}/a.ts`, `${PROJECT}/b.ts`])
  })

  it('carries only the destination of a copy, because the source is a read', () => {
    const deed = oneDeed({ command: 'cp ../other/.env.keys .env.keys' })

    expect(deed.action).toBe(EDeed.WriteFile)
    expect(targetValues({ deed })).toEqual([`${PROJECT}/.env.keys`])
  })

  it('fires on find -delete but not on an ordinary find', () => {
    const deleting = oneDeed({ command: 'find . -name "*.log" -delete' })
    expect(deleting.action).toBe(EDeed.RemovePath)
    expect(targetValues({ deed: deleting })).toEqual([PROJECT])

    expect(actionOf('find . -name "*.log"')).toBe(EDeed.ReadOnly)
  })

  it('sees the rm inside a find -exec', () => {
    expect(actionOf('find . -name "*.tmp" -exec rm {} ;')).toBe(EDeed.RemovePath)
  })

  it('reads a recursive chmod and chown as writes', () => {
    expect(actionOf('chmod -R 755 scripts')).toBe(EDeed.WriteFile)
    expect(actionOf('chown -R me:staff scripts')).toBe(EDeed.WriteFile)
  })

  it('turns a redirect into a write, whatever the program in front of it was', () => {
    const deed = oneDeed({ command: 'echo hi > notes.txt' })

    expect(deed.action).toBe(EDeed.WriteFile)
    expect(targetValues({ deed })).toEqual([`${PROJECT}/notes.txt`])
  })

  it('leaves a redirect to /dev/null alone', () => {
    expect(actionOf('git status > /dev/null')).toBe(EDeed.ReadOnly)
  })

  it('keeps a redirect from downgrading a destructive deed', () => {
    const deed = oneDeed({ command: 'rm -rf build > log.txt' })

    expect(deed.action).toBe(EDeed.RemovePath)
    expect(targetValues({ deed })).toEqual([`${PROJECT}/build`, `${PROJECT}/log.txt`])
  })

  it('sees the rm behind a sudo', () => {
    const deed = oneDeed({ command: 'sudo rm -rf /var/tmp' })

    expect(deed.action).toBe(EDeed.RemovePath)
    expect(targetValues({ deed })).toEqual(['/var/tmp'])
  })

  it('reads sed -i as a write and sed -n as a read', () => {
    expect(actionOf("sed -i 's/a/b/' file.ts")).toBe(EDeed.WriteFile)
    expect(actionOf('sed -n 1,20p file.ts')).toBe(EDeed.ReadOnly)
  })
})
