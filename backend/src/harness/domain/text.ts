import type { BaseMessage } from '@langchain/core/messages';

/** "dennis" → "Dennis". */
export const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Flatten LangChain message content (string | content blocks) to plain text. */
export const flattenContent = (c: BaseMessage['content']): string =>
  typeof c === 'string'
    ? c
    : c.map((p) => (typeof p === 'string' ? p : 'text' in p && typeof p.text === 'string' ? p.text : '')).join('');

/** Escape a string for literal use inside a RegExp (names/ids interpolated into patterns). */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
