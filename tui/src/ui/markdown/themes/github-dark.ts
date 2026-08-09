import type { CodeTheme } from "./code-theme.js";

const INK = {
  /** `fg.default` — body text. */
  fg: "#e6edf3",
  /** `scale.gray[3]` — comments, the only role GitHub recesses. */
  grey: "#8b949e",
  /** `scale.red[3]` — `keyword`, `storage`, `keyword.operator`, `constant.character`. */
  red: "#ff7b72",
  /** `scale.blue[2]` — `constant`, `support`, `meta.property-name`, `markup.heading`. */
  blue: "#79c0ff",
  /** `scale.blue[1]` — `string`, and link destinations. */
  paleBlue: "#a5d6ff",
  /** `scale.purple[2]` — `entity.name.function`, `meta.diff.range`. */
  purple: "#d2a8ff",
  /** `scale.orange[2]` — `entity.name` (types), `variable`, markdown list markers. */
  orange: "#ffa657",
  /** `scale.green[1]` — `entity.name.tag`, `markup.quote`, and JSON property names. */
  green: "#7ee787",
  /** `scale.red[2]` — deleted lines. */
  paleRed: "#ffa198",
  /** `scale.green[9]` / `scale.red[9]` — the diff line backgrounds. */
  addedBg: "#04260f",
  removedBg: "#490202",
} as const;

export const githubDark: CodeTheme = {
  label: "GitHub Dark",
  roles: {
    plain: { fg: INK.fg },
    keyword: { fg: INK.red },
    string: { fg: INK.paleBlue },
    // `constant.character` — GitHub really does put escapes on the keyword red, rather than
    // recessing them the way this app's own theme does.
    escape: { fg: INK.red },
    // No italic: GitHub doesn't slant comments, and the grey already carries "secondary".
    comment: { fg: INK.grey },
    function: { fg: INK.purple },
    // `entity.name` — types and classes.
    type: { fg: INK.orange },
    constant: { fg: INK.blue },
    // `support.type.property-name.json` is the one scope GitHub gives its own colour, and it is
    // green — the single most recognisable thing about a JSON file on github.com.
    key: { fg: INK.green },
    // `meta.object.member` / `variable.other` — member access is plain body text on GitHub. `a.b`
    // is a path through an expression, not a highlight. Stylesheets disagree; see `overrides`.
    property: { fg: INK.fg },
    variable: { fg: INK.fg },
    // `meta.module-reference`.
    module: { fg: INK.blue },
    // `entity.other.attribute-name`, which falls back to `entity` upstream.
    attribute: { fg: INK.blue },
    tag: { fg: INK.green },
    // `keyword.operator` — an arrow function's `=>` really is red on GitHub.
    operator: { fg: INK.red },
    punctuation: { fg: INK.fg },

    heading: { fg: INK.blue, bold: true },
    bold: { fg: INK.fg, bold: true },
    italic: { fg: INK.fg, italic: true },
    quote: { fg: INK.green },
    // `punctuation.definition.list.begin.markdown`.
    listMarker: { fg: INK.orange },
    // `string.other.link` / `constant.other.reference.link`.
    link: { fg: INK.paleBlue },
    // `markup.inline.raw`.
    rawInline: { fg: INK.blue },
    // Upstream uses a real strikethrough, which `StyleDefinitionInput` has no attribute for — dim
    // is the nearest thing that still reads as "crossed out" rather than as emphasis.
    strikethrough: { fg: INK.grey, dim: true },
  },

  overrides: {
    // YAML captures its mapping keys as `@property`, not `@string.special.key` — so without this a
    // YAML file's keys are body text while the identical JSON file's are green.
    yaml: { property: { fg: INK.green } },
    // `support.type.property-name.css` and `entity.other.attribute-name.class` are both blue: in a
    // stylesheet the property name IS the content, not a path through an expression. Custom
    // properties (`--brand`) come through as `@variable`, which upstream is `variable` → orange.
    css: { property: { fg: INK.blue }, variable: { fg: INK.orange } },
  },

  diff: {
    added: { fg: INK.green, bg: INK.addedBg },
    removed: { fg: INK.paleRed, bg: INK.removedBg },
    hunk: { fg: INK.purple, bold: true },
    meta: { fg: INK.blue },
    context: { fg: INK.fg },
  },
};
