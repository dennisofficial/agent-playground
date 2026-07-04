/** Tiny classname joiner (drops falsy values). No clsx dependency needed for this app's scale. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
