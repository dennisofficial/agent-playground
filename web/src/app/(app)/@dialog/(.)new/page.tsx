/**
 * Intercepted `/new` — DEFERRED. The create-thread modal posted to the removed channel API. Nothing
 * routes to `/new` anymore (the sidebar CTA is disabled), so this intercept renders nothing; a hard load
 * of `/new` falls through to the full-page placeholder. Returns with the rebuilt create-thread flow.
 */
export default function NewThreadModal() {
  return null;
}
