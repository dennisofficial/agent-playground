import { describe, expect, it } from 'bun:test'

import { readPartialJson } from '../partial'

describe('reading JSON that has only partly arrived', () => {
  it('reads a document that is already whole', () => {
    expect(readPartialJson('{"file_path":"docs/a.md","content":"# Title"}')).toEqual({
      file_path: 'docs/a.md',
      content: '# Title',
    })
  })

  it('says nothing when nothing has arrived', () => {
    expect(readPartialJson('')).toBeUndefined()
    expect(readPartialJson('   ')).toBeUndefined()
  })

  it('opens an object before any key has arrived', () => {
    expect(readPartialJson('{')).toEqual({})
    expect(readPartialJson('[')).toEqual([])
  })

  it('drops a key that has no value yet', () => {
    expect(readPartialJson('{"file_path')).toEqual({})
    expect(readPartialJson('{"file_path"')).toEqual({})
    expect(readPartialJson('{"file_path":')).toEqual({})
  })

  it('keeps a value the moment it is readable, and forgets the key after it', () => {
    expect(readPartialJson('{"file_path":"docs/a.md"')).toEqual({ file_path: 'docs/a.md' })
    expect(readPartialJson('{"file_path":"docs/a.md",')).toEqual({ file_path: 'docs/a.md' })
    expect(readPartialJson('{"file_path":"docs/a.md","con')).toEqual({ file_path: 'docs/a.md' })
  })

  it('grows a string value as its characters arrive', () => {
    expect(readPartialJson('{"file_path":"docs/a.md","content":"# Is the ver')).toEqual({
      file_path: 'docs/a.md',
      content: '# Is the ver',
    })
  })

  it('holds back an escape that is still mid-flight', () => {
    expect(readPartialJson('{"content":"line\\')).toEqual({ content: 'line' })
    expect(readPartialJson('{"content":"line\\n more')).toEqual({ content: 'line\n more' })
    expect(readPartialJson('{"content":"a\\u00')).toEqual({ content: 'a' })
    expect(readPartialJson('{"content":"a\\u0041')).toEqual({ content: 'aA' })
  })

  it('holds back a number that cannot end where the stream stopped', () => {
    expect(readPartialJson('{"count":12')).toEqual({ count: 12 })
    expect(readPartialJson('{"count":1.')).toEqual({ count: 1 })
    expect(readPartialJson('{"count":-')).toEqual({})
    expect(readPartialJson('{"count":1e')).toEqual({ count: 1 })
  })

  it('holds back a literal that is not yet spelled out', () => {
    expect(readPartialJson('{"ok":tru')).toEqual({})
    expect(readPartialJson('{"ok":true')).toEqual({ ok: true })
    expect(readPartialJson('{"ok":null')).toEqual({ ok: null })
  })

  it('closes every container the stream left open', () => {
    expect(readPartialJson('{"a":{"b":[1,2')).toEqual({ a: { b: [1, 2] } })
    expect(readPartialJson('{"edits":[{"old":"a","new":"b"},{"old":"c')).toEqual({
      edits: [{ old: 'a', new: 'b' }, { old: 'c' }],
    })
    expect(readPartialJson('["a","b')).toEqual(['a', 'b'])
    expect(readPartialJson('[1, ')).toEqual([1])
  })

  it('reads a bare value that is not wrapped in a container', () => {
    expect(readPartialJson('"abc')).toEqual('abc')
    expect(readPartialJson('tru')).toBeUndefined()
  })

  it('tolerates the whitespace a provider may pad the stream with', () => {
    expect(readPartialJson('{\n  "a": 1,\n  "b": "x')).toEqual({ a: 1, b: 'x' })
    expect(readPartialJson('{\n  "a": 1,\n  ')).toEqual({ a: 1 })
  })
})
