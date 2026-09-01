import { describe, expect, it } from 'bun:test'

import {
  backspaceSecretPrompt,
  commitSecretPrompt,
  ESecretCommit,
  openSecretPrompt,
  typeIntoSecretPrompt,
} from '../prompt'

const opened = () => openSecretPrompt({ name: 'search.tavily', label: 'Tavily key', masked: true })

describe('the secret prompt', () => {
  it('opens empty on the secret it was pointed at', () => {
    expect(opened()).toEqual({
      name: 'search.tavily',
      label: 'Tavily key',
      masked: true,
      typed: '',
    })
  })

  it('takes a keystroke and a whole pasted key the same way', () => {
    const typed = typeIntoSecretPrompt({ prompt: opened(), text: 'tvly-' })
    expect(typeIntoSecretPrompt({ prompt: typed, text: 'abcd' }).typed).toBe('tvly-abcd')
  })

  it('drops one whole character at a time, and stops at empty', () => {
    const typed = typeIntoSecretPrompt({ prompt: opened(), text: 'ab' })
    expect(backspaceSecretPrompt(typed).typed).toBe('a')
    expect(backspaceSecretPrompt(backspaceSecretPrompt(backspaceSecretPrompt(typed))).typed).toBe(
      '',
    )
  })

  it('commits the trimmed key, because a paste carries its newline', () => {
    const typed = typeIntoSecretPrompt({ prompt: opened(), text: '  tvly-abcd\n' })
    expect(commitSecretPrompt(typed)).toEqual({
      action: ESecretCommit.Save,
      name: 'search.tavily',
      value: 'tvly-abcd',
    })
  })

  it('reads an empty field as removing the key rather than saving nothing', () => {
    expect(commitSecretPrompt(opened())).toEqual({
      action: ESecretCommit.Clear,
      name: 'search.tavily',
    })
    expect(commitSecretPrompt(typeIntoSecretPrompt({ prompt: opened(), text: '   ' }))).toEqual({
      action: ESecretCommit.Clear,
      name: 'search.tavily',
    })
  })
})
