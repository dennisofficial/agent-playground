import { describe, expect, it } from 'bun:test'

import { htmlToMarkdown, htmlToText, titleOf } from '../extract'

const page = `
  <html>
    <head><title>  A   Page  </title><style>body{color:red}</style></head>
    <body>
      <script>window.evil = 1</script>
      <h1>Heading</h1>
      <p>Some <strong>bold</strong> prose.</p>
      <pre><code>const x = 1</code></pre>
      <ul><li>one</li><li>two</li></ul>
    </body>
  </html>`

describe('htmlToMarkdown', () => {
  it('converts structure to markdown', () => {
    const markdown = htmlToMarkdown(page)
    expect(markdown).toContain('# Heading')
    expect(markdown).toContain('**bold**')
    expect(markdown).toMatch(/-\s+one/)
    expect(markdown).toContain('```')
  })

  it('drops what is not prose, the head included', () => {
    const markdown = htmlToMarkdown(page)
    expect(markdown).not.toContain('window.evil')
    expect(markdown).not.toContain('color:red')
    expect(markdown).not.toContain('A Page')
  })
})

describe('htmlToText', () => {
  it('keeps the words and drops the script', () => {
    const text = htmlToText(page)
    expect(text).toContain('Heading')
    expect(text).toContain('bold')
    expect(text).not.toContain('window.evil')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('A Page')
  })
})

describe('titleOf', () => {
  it('collapses the whitespace in a title', () => {
    expect(titleOf(page)).toBe('A Page')
  })

  it('has none to report when the page carries none', () => {
    expect(titleOf('<html><body>hi</body></html>')).toBeUndefined()
  })
})
