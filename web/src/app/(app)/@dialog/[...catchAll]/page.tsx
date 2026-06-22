/**
 * Catch-all for the `@dialog` slot. Soft-navigations to any route other than `/new` match here and
 * render nothing, which closes the modal (parallel-route behavior — see Next.js modal docs).
 */
export default function DialogCatchAll() {
  return null;
}
