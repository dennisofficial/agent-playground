import { describe, expect, it } from 'bun:test'

import { secretDisplay, SECRET_NOT_NEEDED, SECRET_NOT_SET } from '../settings-format'
import { theme } from '../theme'

describe('what a secret row reads', () => {
  it('says the chosen backend wants nothing rather than showing an empty field', () => {
    const shown = secretDisplay({ held: undefined, masked: true, required: false, takesOne: false })
    expect(shown.text).toBe(SECRET_NOT_NEEDED)
    expect(shown.fg).toBe(theme.meta)
  })

  it('warns when the backend cannot work without the key that is missing', () => {
    const shown = secretDisplay({ held: undefined, masked: true, required: true, takesOne: true })
    expect(shown.text).toBe(SECRET_NOT_SET)
    expect(shown.fg).toBe(theme.warn)
  })

  it('does not warn when the key is optional, because the backend still answers', () => {
    const shown = secretDisplay({ held: undefined, masked: true, required: false, takesOne: true })
    expect(shown.text).toBe(SECRET_NOT_SET)
    expect(shown.fg).toBe(theme.meta)
  })

  it('shows only the tail of a key that is set', () => {
    const shown = secretDisplay({
      held: 'tvly-dev-abcd1234',
      masked: true,
      required: true,
      takesOne: true,
    })
    expect(shown.text).toBe('••••1234')
    expect(shown.fg).toBe(theme.ok)
  })

  it('shows an unmasked value whole, because an instance address is not a secret', () => {
    const shown = secretDisplay({
      held: 'https://searx.example',
      masked: false,
      required: true,
      takesOne: true,
    })
    expect(shown.text).toBe('https://searx.example')
  })

  it('reads an empty stored value as unset', () => {
    expect(secretDisplay({ held: '', masked: true, required: true, takesOne: true }).text).toBe(
      SECRET_NOT_SET,
    )
  })
})
