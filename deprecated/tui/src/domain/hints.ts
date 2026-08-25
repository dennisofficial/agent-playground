/** Forms are given longest-first; the widest one that fits wins. */
export function fitHints(width: number, forms: string[]): string {
  return forms.find((form) => [...form].length <= width) ?? (forms[forms.length - 1] ?? '');
}
