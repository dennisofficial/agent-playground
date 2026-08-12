import { describe, expect, it } from 'bun:test';
import { ESlashCommand, parseSlashCommand } from '../commands.js';

describe('parseSlashCommand', () => {
  it('recognises /rotate, with or without the trailing space the palette leaves behind', () => {
    expect(parseSlashCommand('/rotate')).toBe(ESlashCommand.rotate);
    expect(parseSlashCommand('/rotate ')).toBe(ESlashCommand.rotate);
    expect(parseSlashCommand('  /Rotate  ')).toBe(ESlashCommand.rotate);
  });

  /** The SDK rejects `/compact` and auto-compaction is off, so the word can only mean rotate. */
  it('aliases /compact onto /rotate rather than leaving a dead entry', () => {
    expect(parseSlashCommand('/compact')).toBe(ESlashCommand.rotate);
  });

  it('leaves ordinary prose — and an unrun command — to the agent', () => {
    expect(parseSlashCommand('rotate the log file')).toBeNull();
    expect(parseSlashCommand('what does /rotate do?')).toBeNull();
    // Still only a draft-filler; wiring it is another ticket's, and swallowing it here would make
    // pressing Enter do nothing at all.
    expect(parseSlashCommand('/doctor')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });
});
