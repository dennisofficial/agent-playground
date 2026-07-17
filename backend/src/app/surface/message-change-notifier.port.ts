export const MESSAGE_CHANGE_NOTIFIER = Symbol('MESSAGE_CHANGE_NOTIFIER');

export interface MessageChangeNotifier {
  emitMessagesChanged(repoId: string, jobId: string): void;
}
