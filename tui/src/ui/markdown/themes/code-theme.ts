import type { StyleDefinitionInput } from "@opentui/core";

export type CodeRole =
  /** Everything the theme doesn't name: identifiers, whitespace, tokens no grammar captured. */
  | "plain"
  | "keyword"
  | "string"
  /** `\n` inside a string — meta-content within the string body. */
  | "escape"
  | "comment"
  | "function"
  /** Type names, and constructors, which are type names in call position. */
  | "type"
  /** Literal values that aren't strings: numbers, booleans, named constants. */
  | "constant"
  /**
   * The KEY side of a mapping — a JSON/YAML object key. Separate from `property` because the two
   * are the same Tree-sitter capture in some grammars and opposite colours in most themes: a key is
   * the structure of a config file, where `a.b` is just a path through an expression.
   */
  | "key"
  /** Member access (`a.b`), and in stylesheets the property name and class/id selectors. */
  | "property"
  /** Plain bindings and parameters — the quiet majority of any program. */
  | "variable"
  /** Import paths and namespaces. */
  | "module"
  /** Decorators, annotations, markup attribute names, CSS pseudo-selectors. */
  | "attribute"
  /** Markup element names: HTML/JSX tags, CSS element selectors. */
  | "tag"
  | "operator"
  | "punctuation"
  // ─── markdown, which is a language a fence can be written in too ───────────────────────────
  | "heading"
  | "bold"
  | "italic"
  | "quote"
  /** Bullets and numbers — the chrome of a list, not its content. */
  | "listMarker"
  | "link"
  /** A backticked span inside a markdown fence. */
  | "rawInline"
  /** `StyleDefinitionInput` has no strikethrough attribute, so a theme approximates it. */
  | "strikethrough";

export type DiffPalette = {
  readonly added: StyleDefinitionInput;
  readonly removed: StyleDefinitionInput;
  /** `@@ -1,4 +1,4 @@` — where in the file you are. */
  readonly hunk: StyleDefinitionInput;
  /** `diff --git`, `index`, `---`/`+++` file headers. Which files, not which lines. */
  readonly meta: StyleDefinitionInput;
  /** Unchanged context lines. */
  readonly context: StyleDefinitionInput;
};

export type CodeTheme = {
  readonly label: string;
  readonly roles: Readonly<Record<CodeRole, StyleDefinitionInput>>;
  readonly overrides?: Readonly<
    Record<string, Partial<Record<CodeRole, StyleDefinitionInput>>>
  >;
  readonly diff: DiffPalette;
};

/** A theme's roles for one filetype, with that filetype's corrections folded in. */
export function rolesFor(
  theme: CodeTheme,
  filetype?: string,
): Record<CodeRole, StyleDefinitionInput> {
  const override = filetype ? theme.overrides?.[filetype] : undefined;
  return override ? { ...theme.roles, ...override } : { ...theme.roles };
}

export function codeScopes(
  theme: CodeTheme,
  filetype?: string,
): Record<string, StyleDefinitionInput> {
  const roles = rolesFor(theme, filetype);
  return {
    keyword: roles.keyword,
    // More of the older convention, all of it keyword-shaped: `CASE`/`WHEN` (`conditional`),
    // `TEMPORARY` (`storageclass`), `NOT NULL` (`type.qualifier` — which would otherwise fall back
    // to `type` and colour a constraint like a table name).
    conditional: roles.keyword,
    storageclass: roles.keyword,
    "type.qualifier": roles.keyword,
    comment: roles.comment,
    string: roles.string,
    // A JSON key is the `key` of its value, not another string — without this it falls back to
    // `string` and keys and values render identically, which is exactly the distinction a reader
    // scans a config block for. YAML instead captures its keys as `@property`, which is why themes
    // correct that one per filetype rather than here.
    "string.special.key": roles.key,
    "string.escape": roles.escape,
    escape: roles.escape,
    function: roles.function,
    type: roles.type,
    constructor: roles.type,
    constant: roles.constant,
    number: roles.constant,
    float: roles.constant,
    boolean: roles.constant,
    // A char literal is `constant.character` upstream — the same scope an escape sequence resolves
    // through, which is why it shares that role rather than `string`.
    character: roles.escape,
    property: roles.property,
    "variable.member": roles.property,
    // SQL's queries follow the older nvim convention, where a column is a `field` rather than a
    // `variable.member`. Same idea, third spelling.
    field: roles.property,
    variable: roles.variable,
    parameter: roles.variable,
    module: roles.module,
    attribute: roles.attribute,
    // YAML anchors and aliases (`&base`, `*base`), and loop labels in typescript and zig — a name
    // that points at something rather than being it.
    label: roles.attribute,
    tag: roles.tag,
    operator: roles.operator,
    // `punctuation.bracket`/`.delimiter`/`.special` all fall back to this one correctly.
    punctuation: roles.punctuation,

    // A ```markdown fence is code too, and its grammar emits the same `markup.*` scopes the prose
    // renderer uses. Without these a markdown block draws as flat text inside an otherwise
    // fully-coloured transcript. Numbered headings are listed out because `markup.heading.1` falls
    // back to `markup`, not to `markup.heading`.
    "markup.heading": roles.heading,
    "markup.heading.1": roles.heading,
    "markup.heading.2": roles.heading,
    "markup.heading.3": roles.heading,
    "markup.heading.4": roles.heading,
    "markup.heading.5": roles.heading,
    "markup.heading.6": roles.heading,
    "markup.strong": roles.bold,
    "markup.bold": roles.bold,
    "markup.italic": roles.italic,
    "markup.strikethrough": roles.strikethrough,
    "markup.quote": roles.quote,
    "markup.list": roles.listMarker,
    "markup.list.checked": roles.listMarker,
    "markup.list.unchecked": roles.listMarker,
    "markup.link": roles.link,
    "markup.link.url": roles.link,
    "markup.link.label": roles.link,
    "markup.link.bracket.close": roles.link,
    "markup.raw": roles.rawInline,
    "markup.raw.block": roles.rawInline,
  };
}
