/**
 * DI token a hosting app binds its surface adapter to
 * (`{ provide: MESSAGE_CHANGE_NOTIFIER, useExisting: WebSurface }`).
 */
export const MESSAGE_CHANGE_NOTIFIER = Symbol('MESSAGE_CHANGE_NOTIFIER');

/**
 * A one-way signal that a job's durable message log changed (a send persisted, or a delivery landed) and
 * connected SSE clients should refetch. The stimulus seam depends only on this port so it never imports the
 * concrete surface — the web adapter implements it and re-emits over its own `messagesChanged$` stream.
 */
export interface MessageChangeNotifier {
  emitMessagesChanged(repoId: string, jobId: string): void;
}
