import { describe, expect, it } from 'bun:test'

import { collapseHome, tailOfPath, sessionLabel } from '../paths'

const HOME = '/Users/ada'

describe('collapseHome', () => {
  it('answers ~ for the home directory itself', () => {
    expect(collapseHome({ cwd: HOME, home: HOME })).toBe('~')
  })

  it('collapses a path under home', () => {
    expect(collapseHome({ cwd: `${HOME}/dev/atlas`, home: HOME })).toBe('~/dev/atlas')
  })

  it('leaves a path outside home alone', () => {
    expect(collapseHome({ cwd: '/etc/hosts', home: HOME })).toBe('/etc/hosts')
  })

  it('leaves a sibling of home alone', () => {
    expect(collapseHome({ cwd: '/Users/adaline', home: HOME })).toBe('/Users/adaline')
  })

  it('leaves everything alone when there is no home', () => {
    expect(collapseHome({ cwd: '/srv/atlas', home: '' })).toBe('/srv/atlas')
  })
})

describe('tailOfPath', () => {
  it('leaves a path that already fits', () => {
    expect(tailOfPath({ path: '~/dev/atlas', cells: 20 })).toBe('~/dev/atlas')
  })

  it('drops leading segments to fit', () => {
    const tail = tailOfPath({ path: '~/dev/work/comp/atlas', cells: 14 })
    expect(tail).toBe('…/comp/atlas')
    expect([...tail].length).toBeLessThanOrEqual(14)
  })

  it('cuts to a segment boundary rather than mid-name', () => {
    expect(tailOfPath({ path: '~/dev/work/atlas', cells: 12 })).toBe('…/work/atlas')
  })

  it('falls back to the bare tail when no boundary fits', () => {
    expect(tailOfPath({ path: '~/averyverylongdirectory', cells: 8 })).toBe('…rectory')
  })
})

describe('sessionLabel', () => {
  const home = '/Users/dev'
  const projectDirectory = '/Users/dev/atlas'

  it('shows the collapsed project path while the session has not moved', () => {
    expect(sessionLabel({ projectDirectory, sessionDirectory: projectDirectory, home })).toEqual({
      path: '~/atlas',
      moved: false,
    })
  })

  it('shows the path relative to the project once the session moves inside it', () => {
    expect(
      sessionLabel({ projectDirectory, sessionDirectory: '/Users/dev/atlas/packages/harness', home }),
    ).toEqual({ path: 'packages/harness', moved: true })
  })

  it('shows a collapsed absolute path once the session leaves the project', () => {
    expect(sessionLabel({ projectDirectory, sessionDirectory: '/Users/dev/Downloads', home })).toEqual({
      path: '~/Downloads',
      moved: true,
    })
  })

  it('does not mistake a sibling directory sharing the project prefix for a child', () => {
    expect(sessionLabel({ projectDirectory, sessionDirectory: '/Users/dev/atlas-notes', home })).toEqual({
      path: '~/atlas-notes',
      moved: true,
    })
  })
})
