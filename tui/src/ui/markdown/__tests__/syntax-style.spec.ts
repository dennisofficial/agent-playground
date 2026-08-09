import { SyntaxStyle } from '@opentui/core';
import { describe, expect, it } from 'bun:test';
import { theme } from '../../theme.js';
import { codeSyntaxStyleFor, proseScopes, proseSyntaxStyle } from '../syntax-style.js';
import {
  CODE_THEMES,
  codeScopes,
  DEFAULT_CODE_THEME,
  resolveCodeTheme,
  rolesFor,
} from '../themes/index.js';

describe('syntax styles', () => {
  it('construct without throwing and are SyntaxStyle instances', () => {
    expect(proseSyntaxStyle).toBeInstanceOf(SyntaxStyle);
    expect(codeSyntaxStyleFor('typescript')).toBeInstanceOf(SyntaxStyle);
  });

  it('are two handles, not one — prose answers to the app theme, code to the selected theme', () => {
    expect(codeSyntaxStyleFor('typescript')).not.toBe(proseSyntaxStyle);
  });

  it('caches one style per filetype rather than building one per block', () => {
    expect(codeSyntaxStyleFor('python')).toBe(codeSyntaxStyleFor('python'));
    expect(codeSyntaxStyleFor('python')).not.toBe(codeSyntaxStyleFor('yaml'));
  });

  it('is a shared module instance — importing prose twice yields the same reference', async () => {
    const again = await import('../syntax-style.js');
    expect(again.proseSyntaxStyle).toBe(proseSyntaxStyle);
  });

  it('draws inline code in the accent, and fenced machine text in the blue', () => {
    // The distinction this pins: a backticked word mid-sentence is prose the eye should catch,
    // while a fence is a quotation that should sit still. They stopped sharing a colour, and a
    // future edit that collapses them again should have to argue with this line.
    expect(proseScopes['markup.raw']).toEqual({ fg: theme.accent });
    expect(proseScopes['markup.raw.block']).toEqual({ fg: theme.code });
    expect(theme.codeInline).not.toBe(theme.code);
    // Headings are the accent too — weight is what keeps them apart from an inline identifier.
    expect(proseScopes['markup.heading.2']).toMatchObject({ fg: theme.accent, bold: true });
    expect(proseScopes['markup.raw']).not.toHaveProperty('bold');
  });
});

describe('code themes', () => {
  it('every registered theme builds a style, and none of them sets `default`', () => {
    for (const [name, theme] of Object.entries(CODE_THEMES)) {
      const scopes = codeScopes(theme);
      // `default` belongs to whoever builds the style, never to a theme's scope map: the prose
      // style merges these scopes in, and a `default` here would recolour every word of English.
      expect(scopes.default, name).toBeUndefined();
      expect(SyntaxStyle.fromStyles(scopes)).toBeInstanceOf(SyntaxStyle);
    }
  });

  it('applies per-filetype overrides over the base roles, and only for that filetype', () => {
    const gh = CODE_THEMES['github-dark'];
    // The bug this exists for: a YAML key is `@property`, the same capture as JS member access.
    expect(rolesFor(gh, 'yaml').property).not.toEqual(rolesFor(gh, 'javascript').property);
    expect(rolesFor(gh, 'javascript').property).toEqual(gh.roles.property);
    // A JSON key arrives as its own capture, so it needs no override to be right.
    expect(codeScopes(gh)['string.special.key']).toEqual(gh.roles.key);
  });

  it('resolves an unknown or missing name to the default rather than throwing', () => {
    expect(resolveCodeTheme('solarized-mauve')).toBe(CODE_THEMES[DEFAULT_CODE_THEME]);
    expect(resolveCodeTheme(null)).toBe(CODE_THEMES[DEFAULT_CODE_THEME]);
    expect(resolveCodeTheme('atlas')).toBe(CODE_THEMES.atlas);
  });
});
