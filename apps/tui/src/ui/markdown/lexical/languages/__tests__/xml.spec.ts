import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { xml as spec } from '../xml'

const declaration = ['<?xml version="1.0"?>', '<message>Hello, World!</message>'].join('\n')

const source = [
  declaration,
  '',
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE catalog>',
  '<!-- a namespaced catalogue -->',
  '<catalog xmlns:dc="http://purl.org/dc/elements/1.1/">',
  "  <dc:title lang='en'>Calculator &amp; Friends</dc:title>",
  '  <entry id="a-1" price="12.50">',
  '    <summary><![CDATA[if (x < y) { total += 1; }]]></summary>',
  '    <note>Rounds to 2 places &#8212; always.</note>',
  '    <updated>Mon, 01 Jan 2024 00:00:00 GMT</updated>',
  '  </entry>',
  '</catalog>',
  '',
].join('\n')

const emitted = ['keyword.directive', 'comment', 'tag', 'attribute', 'string', 'string.escape']

describe('xml lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({ spec, source, groups: emitted })
  })

  it('emits nothing outside the groups it claims', () => {
    expect(groupsIn({ spec, source })).toEqual(new Set(emitted))
  })

  it('reads the declaration delimiters as a directive and still lexes inside them', () => {
    expect(textFor({ spec, source: declaration, group: 'keyword.directive' })).toEqual(['<?xml', '?>'])
    expect(textFor({ spec, source: declaration, group: 'attribute' })).toEqual(['version'])
    expect(textFor({ spec, source: declaration, group: 'string' })).toEqual(['"1.0"'])
  })

  it('reads every markup declaration of an internal dtd subset as a directive', () => {
    const subset = [
      '<!DOCTYPE note [',
      '  <!ELEMENT note (to,from)>',
      '  <!ATTLIST note id ID #REQUIRED>',
      '  <!ENTITY nbsp "&#160;">',
      '  <!NOTATION gif SYSTEM "image/gif">',
      ']>',
    ].join('\n')
    expect(textFor({ spec, source: subset, group: 'keyword.directive' })).toEqual([
      '<!DOCTYPE',
      '<!ELEMENT',
      '<!ATTLIST',
      '<!ENTITY',
      '<!NOTATION',
    ])
    expectPlain({ spec, source: subset, text: 'note [' })
  })

  it('reads namespaced and non-ascii element and attribute names whole', () => {
    const namespaced = '<dc:title xml:lang="en-GB"/>'
    expect(textFor({ spec, source: namespaced, group: 'tag' })).toEqual(['<dc:title'])
    expect(textFor({ spec, source: namespaced, group: 'attribute' })).toEqual(['xml:lang'])
    expect(textFor({ spec, source: '<café>x</café>', group: 'tag' })).toEqual(['<café', '</café'])
  })

  it('reads opening and closing tag names', () => {
    expect(textFor({ spec, source, group: 'tag' })).toEqual([
      '<message',
      '</message',
      '<catalog',
      '<dc:title',
      '</dc:title',
      '<entry',
      '<summary',
      '</summary',
      '<note',
      '</note',
      '<updated',
      '</updated',
      '</entry',
      '</catalog',
    ])
  })

  it('reads attribute names only where a value follows', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual([
      'version',
      'version',
      'encoding',
      'xmlns:dc',
      'lang',
      'id',
      'price',
    ])
  })

  it('reads both quoting styles of attribute value as strings', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"1.0"',
      '"1.0"',
      '"UTF-8"',
      '"http://purl.org/dc/elements/1.1/"',
      "'en'",
      '"a-1"',
      '"12.50"',
      '<![CDATA[if (x < y) { total += 1; }]]>',
    ])
  })

  it('reads named and numeric entities as escapes', () => {
    expect(textFor({ spec, source, group: 'string.escape' })).toEqual(['&amp;', '&#8212;'])
  })

  it('takes a cdata section literally, ahead of the tag and entity rules', () => {
    const cdata = '<![CDATA[<b>bold & raw</b>]]>'
    expect(textFor({ spec, source: cdata, group: 'string' })).toEqual([cdata])
    expect(groupsIn({ spec, source: cdata })).toEqual(new Set(['string']))
  })

  it('takes a comment ahead of the tag and directive rules', () => {
    const comment = '<!-- <fake attr="1"> <?xml version="1.0"?> -->'
    expect(textFor({ spec, source: comment, group: 'comment' })).toEqual([comment])
    expect(groupsIn({ spec, source: comment })).toEqual(new Set(['comment']))
  })

  it('leaves element text content alone', () => {
    expectPlain({ spec, source, text: 'Hello, World!' })
    expectPlain({ spec, source, text: '!</message>' })
    expectPlain({ spec, source, text: 'Friends' })
  })

  it('leaves digits in character data alone', () => {
    expectPlain({ spec, source, text: '2 places' })
    expectPlain({ spec, source, text: '01 Jan 2024' })
    expectPlain({ spec, source: '<version>3.11.0</version>', text: '3.11.0' })
  })

  it('leaves a quoted phrase and an apostrophe in text content alone', () => {
    expectPlain({ spec, source: '<p>He said "hi" to me</p>', text: '"hi"' })
    expectPlain({ spec, source: "<p>Don't panic, it's fine</p>", text: "'t panic" })
  })

  it('answers to the document dialects too', () => {
    expect(spec.aliases).toContain('svg')
    expect(spec.aliases).toContain('xslt')
  })
})
