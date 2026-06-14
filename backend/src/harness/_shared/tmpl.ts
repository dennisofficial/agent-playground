/**
 * `tmpl` — the house prompt-template helper. A tagged template whose interpolated values are the
 * STRING NAMES of slots; it returns a typed renderer `(vars) => string` that substitutes each slot.
 *
 * Why this and not LangChain `PromptTemplate`: our prompt bodies are brace-heavy (JSON/code examples
 * like `{ summary: newSummary }`), and f-string `{var}` templating would force escaping every literal
 * brace. `tmpl` never parses `{`/`}`, so bodies pass through verbatim. The slot names are inferred as a
 * union, so `Record<K, string>` makes a missing slot a COMPILE error.
 *
 *   const EXECUTE = tmpl`Execute this approved plan.\nTICKET:\n${'ticket'}\n\nPLAN:\n${'plan'}`;
 *   EXECUTE({ ticket, plan }); // → string
 *
 * NO auto-trim, on purpose: prompts embedded into the byte-stable cached chat/worker prompts depend on
 * exact leading/trailing bytes and blank-line boundaries; trimming would shift them and bust the prompt
 * cache. Call `.trim()` yourself on standalone prompts that want it.
 */
export function tmpl<const K extends string>(
  strings: TemplateStringsArray,
  ...keys: K[]
): (vars: Record<K, string>) => string {
  return (vars) =>
    strings.reduce(
      (out, s, i) => out + s + (i < keys.length ? vars[keys[i]] : ''),
      '',
    );
}
