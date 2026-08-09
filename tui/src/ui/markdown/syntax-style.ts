import { SyntaxStyle, type StyleDefinitionInput } from "@opentui/core";
import { theme } from "../theme.js";
import {
  codeScopes,
  codeTheme,
  rolesFor,
  type CodeTheme,
} from "./themes/index.js";

export const proseScopes: Record<string, StyleDefinitionInput> = {
  // No colour, no weight. Prose renders in whatever foreground the host component already set, the
  // same "spend colour only where it carries meaning" rule `theme.ts` states for the ANSI renderer.
  default: {},

  // Headings take the accent because they are the one place in prose that should pull the eye
  // first, same role `⏺`/`❯` play in the transcript. Weight increases toward h1 (bold, italic,
  // underline) and softens after h3 (bold + dim) so six levels stay ordered without six colours.
  "markup.heading.1": {
    fg: theme.accent,
    bold: true,
    italic: true,
    underline: true,
  },
  "markup.heading.2": { fg: theme.accent, bold: true },
  "markup.heading.3": { fg: theme.accent, bold: true, dim: true },
  "markup.heading.4": { fg: theme.accent, bold: true, dim: true },
  "markup.heading.5": { fg: theme.accent, bold: true, dim: true },
  "markup.heading.6": { fg: theme.accent, bold: true, dim: true },
  // Table header cells (`pipe_table_header`) reuse the same capture family conceptually but the
  // grammar emits the un-numbered `markup.heading` for them.
  "markup.heading": { fg: theme.accent, bold: true },

  // Weight carries emphasis, not colour — matching the ANSI renderer, which never colours bold or
  // italic text either. The grammar emits `markup.strong`; `markup.bold` is kept as an alias in
  // case a caller (or a future grammar revision) registers under that name instead.
  "markup.strong": { bold: true },
  "markup.bold": { bold: true },
  "markup.italic": { italic: true },
  // `StyleDefinitionInput` has no strikethrough attribute, so this is approximated with dim —
  // still visibly de-emphasised, which is the point of strikethrough in a transcript.
  "markup.strikethrough": { dim: true },

  // Blockquotes are dim italic in the ANSI renderer (`chalk.dim.italic` in markdown.ts) for the
  // same reason here: a quote is someone else's words, not the model's — it should read as quieter
  // than surrounding prose, never as emphasis.
  "markup.quote": { fg: theme.dim, italic: true },

  // List bullets/numbers are chrome, not content — dimmed so the eye lands on the item text.
  // Checked/unchecked task markers borrow `ok`/`dim` to say "done" vs "not done" without adding a
  // colour the rest of the theme doesn't already use for that meaning.
  "markup.list": { fg: theme.dim },
  "markup.list.checked": { fg: theme.ok },
  "markup.list.unchecked": { fg: theme.dim },

  // Inline code takes the APP's accent, never the code theme's colours: a `variable` named
  // mid-sentence is part of the prose, and it should not change colour because a fenced block three
  // lines down is being drawn in someone else's palette. See `theme.codeInline` for why the accent
  // and not the machine-text blue.
  "markup.raw": { fg: theme.codeInline },
  // Raw BLOCKS reach the prose renderer only when a fence is nested inside a blockquote or list —
  // the segmenter pulls top-level fences out to a `<code>` element. It follows FENCED code, not
  // inline: it is a block, and a paragraph-sized run of accent would shout where a fence should sit
  // still. (The markdown grammar hands it over whole, with no language and no tokens inside it to
  // theme, so it gets the one flat colour that means "machine text".)
  "markup.raw.block": { fg: theme.code },

  // Links share the code blue, so the underline is what tells the two apart — the one attribute
  // prose hasn't already spent (bold on headings, italic on quotes, dim on chrome). It is solid,
  // not dotted: `StyleDefinitionInput` exposes `underline` as a boolean, and the dotted variant
  // would need a raw `4:4` escape, which a text buffer measures as literal characters.
  "markup.link": { fg: theme.link, underline: true },
  "markup.link.url": { fg: theme.link, underline: true },
  "markup.link.label": { fg: theme.link, underline: true },
  "markup.link.bracket.close": { fg: theme.link, underline: true },

  // Table pipes, thematic breaks, and blockquote continuation markers are punctuation chrome, not
  // content — same treatment as list markers.
  "punctuation.special": { fg: theme.dim },
  "punctuation.delimiter": { fg: theme.dim },
  // A backslash-escaped markdown character (`\*`) is literal text, not markup — slightly quieter
  // than the surrounding prose, never its own emphasis.
  "string.escape": { fg: theme.dim },
  // Frontmatter delimiters (`+++`/`---`) are metadata, not prose — dimmed like other chrome.
  "keyword.directive": { fg: theme.dim },
  // The fenced-code language annotation and HTML-entity substitutions are concealed by default
  // (`conceal: true`); when concealment is off they should not compete with real content.
  label: { fg: theme.dim },
  "character.special": {},
};

export const proseSyntaxStyle: SyntaxStyle = SyntaxStyle.fromStyles({
  ...codeScopes(codeTheme),
  ...proseScopes,
});

export function buildCodeSyntaxStyle(
  selected: CodeTheme,
  filetype?: string,
): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    ...codeScopes(selected, filetype),
    default: rolesFor(selected, filetype).plain,
  });
}

const byFiletype = new Map<string, SyntaxStyle>();

export function codeSyntaxStyleFor(filetype: string): SyntaxStyle {
  const cached = byFiletype.get(filetype);
  if (cached) return cached;
  const built = buildCodeSyntaxStyle(codeTheme, filetype);
  byFiletype.set(filetype, built);
  return built;
}
