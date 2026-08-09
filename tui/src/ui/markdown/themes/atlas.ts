import { theme } from "../../theme.js";
import type { CodeTheme } from "./code-theme.js";

export const atlasCode: CodeTheme = {
  label: "Atlas",
  roles: {
    plain: {},
    // Keywords get the accent: in a code block they are the structural "headline" tokens (control
    // flow, declarations) the same way a heading is the headline of a paragraph.
    keyword: { fg: theme.accent, bold: true },
    // Strings are the one place `theme.ok` earns a second job: a string is inert data, the calmest
    // thing on the line, and green already reads as "this is fine, keep scanning" elsewhere.
    string: { fg: theme.ok },
    escape: { fg: theme.dim },
    // Dimmed and italic for the same reason blockquotes are: commentary *about* the code.
    comment: { fg: theme.dim, italic: true },
    // Named things the code refers to, in the machine-text blue. Prose spends the accent on inline
    // code instead (see `theme.codeInline`), and a fence should not: inside a block nearly every
    // token is a named thing, and a wall of accent stops distinguishing anything.
    function: { fg: theme.code },
    type: { fg: theme.code },
    // A third hue, reserved for literal values that are not strings, so a `42` or `true` stands out
    // from both keywords and string data.
    constant: { fg: theme.warn },
    key: { fg: theme.code },
    property: { fg: theme.code },
    variable: {},
    module: { fg: theme.code },
    attribute: { fg: theme.code },
    tag: { fg: theme.code },
    // Structural noise around the content, dimmed like markdown's table pipes and list markers.
    operator: { fg: theme.dim },
    punctuation: { fg: theme.dim },

    // Markdown inside a fence, mirroring how the prose renderer draws the same constructs — a
    // ```markdown block should look like the transcript's own prose, one border in.
    heading: { fg: theme.accent, bold: true },
    bold: { bold: true },
    italic: { italic: true },
    quote: { fg: theme.dim, italic: true },
    listMarker: { fg: theme.dim },
    link: { fg: theme.link, underline: true },
    rawInline: { fg: theme.codeInline },
    strikethrough: { dim: true },
  },

  /** Nothing per-language: every role here is already the same idea in every grammar. */

  /** No line backgrounds — `theme.error` is red-only-for-failure, and a removed line is not one. */
  diff: {
    added: { fg: theme.ok },
    removed: { fg: theme.error },
    hunk: { fg: theme.accent, bold: true },
    meta: { fg: theme.dim },
    context: {},
  },
};
