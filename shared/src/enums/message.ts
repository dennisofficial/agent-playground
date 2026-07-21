export enum EThreadMessageKind {
  CHAT = 'chat',
  THINKING = 'thinking',
  TOOL = 'tool',
  CARD = 'card',
  BUILD_EVENT = 'build_event',
}

export enum EThreadMessageSource {
  OPERATOR = 'operator',
  ATLAS = 'atlas',
  SYSTEM = 'system', // harness-authored (notices, events, reminders, injected context) — Atlas didn't write it
  UNTRUSTED = 'untrusted', // content from an untrusted external source, folded into a turn
}

export enum EMessageAudience {
  OPERATOR_ONLY = 'operator_only', // rendered to the operator; never enters Atlas's context
  SHARED = 'shared', // rendered to the operator AND part of Atlas's context
}
