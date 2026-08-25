import { SyntaxStyle } from '@opentui/core'
import { afterEach, describe, expect, it } from 'bun:test'

import { applyPalette, resetPalette } from '../../palette-store'
import { theme } from '../../theme'
import { codeSyntaxStyleFor, proseScopes, proseSyntaxStyle } from '../syntax-style'
import {
  codeScopes,
  codeTheme,
  codeThemeNames,
  DEFAULT_CODE_THEME,
  resolveCodeTheme,
  rolesFor,
  selectedCodeTheme,
  setCodeTheme,
} from '../themes/index'

afterEach(() => {
  setCodeTheme(DEFAULT_CODE_THEME)
  resetPalette()
})

describe('syntax styles', () => {
  it('construct without throwing and are SyntaxStyle instances', () => {
    expect(proseSyntaxStyle()).toBeInstanceOf(SyntaxStyle)
    expect(codeSyntaxStyleFor('typescript')).toBeInstanceOf(SyntaxStyle)
  })

  it('are two handles, not one — prose answers to the app theme, code to the selected theme', () => {
    expect(codeSyntaxStyleFor('typescript')).not.toBe(proseSyntaxStyle())
  })

  it('caches one style per filetype rather than building one per block', () => {
    expect(codeSyntaxStyleFor('python')).toBe(codeSyntaxStyleFor('python'))
    expect(codeSyntaxStyleFor('python')).not.toBe(codeSyntaxStyleFor('yaml'))
  })

  it('caches the prose style too, rather than recompiling it every render', () => {
    expect(proseSyntaxStyle()).toBe(proseSyntaxStyle())
  })

  it('is a shared module instance — importing prose twice yields the same reference', async () => {
    const again = await import('../syntax-style')
    expect(again.proseSyntaxStyle()).toBe(proseSyntaxStyle())
  })

  it('draws inline code in the accent, and fenced machine text in the blue', () => {
    expect(proseScopes()['markup.raw']).toEqual({ fg: theme.accent })
    expect(proseScopes()['markup.raw.block']).toEqual({ fg: theme.code })
    expect(theme.codeInline).not.toBe(theme.code)
    expect(proseScopes()['markup.heading.2']).toMatchObject({ fg: theme.accent, bold: true })
    expect(proseScopes()['markup.raw']).not.toHaveProperty('bold')
  })
})

describe('syntax styles follow the palette', () => {
  it('rebuilds the prose scopes when a colour moves', () => {
    expect(proseScopes()['markup.raw']).toEqual({ fg: '#d97757' })
    applyPalette({ codeInline: '#00ff00' })
    expect(proseScopes()['markup.raw']).toEqual({ fg: '#00ff00' })
  })

  it('drops the compiled prose style, so <markdown> is handed a new one', () => {
    const before = proseSyntaxStyle()
    applyPalette({ accent: '#00ff00' })
    expect(proseSyntaxStyle()).not.toBe(before)
  })

  it('clears the per-filetype cache — the bug this would otherwise ship', () => {
    const before = codeSyntaxStyleFor('typescript')
    applyPalette({ accent: '#00ff00' })
    expect(codeSyntaxStyleFor('typescript')).not.toBe(before)
  })
})

describe('code themes', () => {
  it('every registered theme builds a style, and none of them sets `default`', () => {
    for (const name of codeThemeNames()) {
      const scopes = codeScopes({ theme: resolveCodeTheme(name) })
      expect(scopes.default, name).toBeUndefined()
      expect(SyntaxStyle.fromStyles(scopes)).toBeInstanceOf(SyntaxStyle)
    }
  })

  it('applies per-filetype overrides over the base roles, and only for that filetype', () => {
    const gh = resolveCodeTheme('github-dark')
    expect(rolesFor({ theme: gh, filetype: 'yaml' }).property).not.toEqual(
      rolesFor({ theme: gh, filetype: 'javascript' }).property,
    )
    expect(rolesFor({ theme: gh, filetype: 'javascript' }).property).toEqual(gh.roles.property)
    expect(codeScopes({ theme: gh })['string.special.key']).toEqual(gh.roles.key)
  })

  it('resolves an unknown or missing name to the default rather than throwing', () => {
    const fallback = resolveCodeTheme(DEFAULT_CODE_THEME)
    expect(resolveCodeTheme('solarized-mauve')).toEqual(fallback)
    expect(resolveCodeTheme(null)).toEqual(fallback)
    expect(resolveCodeTheme('atlas').label).toBe('Atlas')
  })

  it('selects by name at runtime, which a frozen const could not do', () => {
    expect(selectedCodeTheme()).toBe(DEFAULT_CODE_THEME)
    setCodeTheme('atlas')
    expect(selectedCodeTheme()).toBe('atlas')
    expect(codeTheme().label).toBe('Atlas')
  })

  it('falls back rather than throwing when handed a name it does not know', () => {
    setCodeTheme('solarized-mauve')
    expect(selectedCodeTheme()).toBe(DEFAULT_CODE_THEME)
  })

  it('rebuilds `atlas` from the palette, because that theme IS a view of it', () => {
    setCodeTheme('atlas')
    expect(codeTheme().roles.keyword).toMatchObject({ fg: '#d97757' })
    applyPalette({ accent: '#00ff00' })
    expect(codeTheme().roles.keyword).toMatchObject({ fg: '#00ff00' })
  })

  it('leaves `github-dark` alone when the palette moves — it is not a view of anything', () => {
    const before = resolveCodeTheme('github-dark').roles.keyword
    applyPalette({ accent: '#00ff00' })
    expect(resolveCodeTheme('github-dark').roles.keyword).toEqual(before)
  })
})
