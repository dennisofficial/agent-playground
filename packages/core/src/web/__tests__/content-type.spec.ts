import { describe, expect, it } from 'bun:test'

import { acceptContentType, EContentVerdict, looksBinary } from '../content-type'

describe('acceptContentType', () => {
  it('names a PDF rather than handing back its bytes as prose', () => {
    const verdict = acceptContentType('application/pdf')
    expect(verdict.verdict).toBe(EContentVerdict.Document)
    if (verdict.verdict === EContentVerdict.Text) return
    expect(verdict.reason).toContain('a PDF')
  })

  it('refuses pictures, video and audio', () => {
    for (const type of ['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg', 'font/woff2']) {
      expect(acceptContentType(type).verdict).toBe(EContentVerdict.Binary)
    }
  })

  it('refuses an unknown binary rather than guessing', () => {
    expect(acceptContentType('application/octet-stream').verdict).toBe(EContentVerdict.Binary)
    expect(acceptContentType('application/zip').verdict).toBe(EContentVerdict.Binary)
  })

  it('accepts the textual families and marks which are html', () => {
    const html = acceptContentType('text/html; charset=utf-8')
    expect(html.verdict).toBe(EContentVerdict.Text)
    if (html.verdict !== EContentVerdict.Text) return
    expect(html.html).toBe(true)

    for (const type of [
      'text/plain',
      'text/markdown',
      'application/json',
      'application/ld+json',
      'image/svg+xml',
    ]) {
      const verdict = acceptContentType(type)
      expect(verdict.verdict).toBe(EContentVerdict.Text)
      if (verdict.verdict !== EContentVerdict.Text) continue
      expect(verdict.html).toBe(false)
    }
  })

  it('reads through the charset parameter rather than tripping on it', () => {
    expect(acceptContentType('TEXT/HTML;charset=ISO-8859-1').verdict).toBe(EContentVerdict.Text)
  })

  it('lets a server that declared nothing through, since many serve pages that way', () => {
    expect(acceptContentType('').verdict).toBe(EContentVerdict.Text)
  })
})

describe('looksBinary', () => {
  it('catches a binary that claimed to be text', () => {
    expect(looksBinary(new Uint8Array([0x25, 0x50, 0x44, 0x00, 0x46]))).toBe(true)
  })

  it('leaves ordinary text alone', () => {
    expect(looksBinary(new TextEncoder().encode('# A page\n\nwith prose in it'))).toBe(false)
  })

  it('only reads the opening, so a NUL far into a large file is not searched for', () => {
    const bytes = new Uint8Array(4096)
    bytes.fill(0x61)
    bytes[3000] = 0
    expect(looksBinary(bytes)).toBe(false)
  })
})
