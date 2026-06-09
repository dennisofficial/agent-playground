import type { RenderItem } from './messages.js';

/**
 * Set on exit (before Ink unmounts); [index.tsx](../index.tsx) writes it to the restored primary screen
 * after `waitUntilExit()`. Because we run in the alternate screen buffer (no native scrollback), this is
 * how the full conversation — debug rows included — survives quitting: copyable, pipeable, in scrollback.
 */
export const sessionDump: { text: string } = { text: '' };

const reactionsLine = (rs?: { by: string; emoji: string }[]): string =>
  rs?.length ? `\n   ↳ ${rs.map((r) => `${r.by} ${r.emoji}`).join('  ')}` : '';

/** A readable, ANSI-free line (or small block) for one item — used only for the on-exit transcript dump. */
export function toPlainText(item: RenderItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant':
      return `${item.speaker ?? (item.kind === 'user' ? 'You' : 'bot')}: ${item.text}${reactionsLine(
        item.reactions,
      )}`;
    case 'tool':
      return `  ⚙ ${item.speaker ? `${item.speaker}: ` : ''}${item.toolName}`;
    case 'reaction':
      return `   ↳ ${item.by} reacted ${item.emoji}`;
    case 'recall':
      return `   ↳ ${item.by} recalled: ${item.text}`;
    case 'gate':
      return `   ▸ gate · ${item.by} → ${item.action}: ${item.reasoning}`;
    case 'note':
      return item.text;
    case 'approval':
      return `${item.decision === 'approved' ? '✓' : '✕'} ${item.by} ${item.decision} ${item.jobId}${
        item.note ? ` — ${item.note}` : ''
      }`;
    case 'error':
      return `⚠ ${item.text}`;
    case 'worker':
    case 'memory':
    case 'reminders':
    case 'workspace':
      return `   ▪ ${item.by ? `${item.by} ` : ''}[${item.kind}] ${item.text}`;
  }
}
