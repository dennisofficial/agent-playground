import { describe, expect, it } from 'bun:test'

import { classify } from '../classify'
import { humanBytes, imageOf, imageSummary } from '../images'
import { EDetail, EGather, EToolClass } from '../kinds'
import { aCall, CWD } from './fixture'

const anImageRead = (output: Record<string, unknown>) =>
  aCall({
    name: 'read',
    input: { path: `${CWD}/docs/shot.png` },
    output,
    modelText: `${CWD}/docs/shot.png — image/png, 1024×768, 412 KB.`,
  })

const settled = anImageRead({
  path: `${CWD}/docs/shot.png`,
  mediaType: 'image/png',
  byteLength: 412 * 1024,
  width: 1024,
  height: 768,
  inlined: true,
})

describe('a read that came back as a picture', () => {
  it('gets its own renderer rather than the syntax-highlighted one', () => {
    const classified = classify({ call: settled, cwd: CWD })

    expect(classified.detail).toBe(EDetail.Image)
    expect(classified.klass).toBe(EToolClass.Gathered)
    expect(classified.gather).toBe(EGather.Read)
  })

  it('measures itself in pixels, since it has no lines to count', () => {
    const classified = classify({ call: settled, cwd: CWD })

    expect(classified.line).toBe('docs/shot.png')
    expect(classified.note).toBe('1024×768')
    expect(classified.metric).toBeNull()
    expect(classified.alone).toBe('Read docs/shot.png')
  })

  it('summarises as the path, its dimensions and its weight', () => {
    expect(imageSummary({ call: settled, cwd: CWD })).toBe('docs/shot.png · 1024×768 · 412 KB')
  })

  it('leaves out what the tool could not tell it', () => {
    const unsized = anImageRead({
      path: `${CWD}/docs/shot.png`,
      mediaType: 'image/png',
      byteLength: 900,
    })

    expect(imageSummary({ call: unsized, cwd: CWD })).toBe('docs/shot.png · 900 B')
    expect(classify({ call: unsized, cwd: CWD }).note).toBe('900 B')
  })

  it('says so even when the picture was too big to send', () => {
    const declined = anImageRead({
      path: `${CWD}/docs/shot.png`,
      mediaType: 'image/png',
      byteLength: 20 * 1024 * 1024,
      width: 4000,
      height: 3000,
      inlined: false,
    })

    expect(classify({ call: declined, cwd: CWD }).detail).toBe(EDetail.Image)
    expect(imageSummary({ call: declined, cwd: CWD })).toBe('docs/shot.png · 4000×3000 · 20.0 MB')
  })
})

describe('a read that came back as text', () => {
  const textRead = aCall({
    name: 'read',
    input: { path: `${CWD}/src/theme.ts` },
    output: { path: `${CWD}/src/theme.ts`, lines: 40, truncated: false },
  })

  it('is untouched by the image path', () => {
    expect(imageOf(textRead)).toBeNull()
    expect(imageSummary({ call: textRead, cwd: CWD })).toBeNull()
    expect(classify({ call: textRead, cwd: CWD }).detail).toBe(EDetail.File)
    expect(classify({ call: textRead, cwd: CWD }).note).toBe('40 l')
  })
})

describe('how a size reads', () => {
  it('grows a unit at a time', () => {
    expect(humanBytes(0)).toBe('0 B')
    expect(humanBytes(1023)).toBe('1023 B')
    expect(humanBytes(1024)).toBe('1 KB')
    expect(humanBytes(1024 * 1024 - 1)).toBe('1024 KB')
    expect(humanBytes(1024 * 1024)).toBe('1.0 MB')
  })
})
